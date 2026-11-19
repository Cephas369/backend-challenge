import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import {
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  PersistenceInvariantError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from '../../application/errors';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { InvalidMoneyError, Money } from '../../domain/money/money';
import { canonicalJson } from '../../domain/wagering/wager-payload';
import { InvalidWagerTransactionError } from '../../domain/wagering/wager-transaction';
import { runWithLogContext } from '../../infrastructure/observability/log-context';
import type { AppLogger } from '../../infrastructure/observability/logger';
import type { QueueUrls } from '../../infrastructure/sqs/queue-urls';
import {
  type WagerTransactionRequestedMessage,
  wagerTransactionRequestedMessage,
} from '../contracts/wager-contracts';
import { Sleeper } from '../workers/sleeper';

export interface WagerConsumerOptions {
  readonly queueName: string;
  readonly dlqName: string;
  /** Identidade lógica na inbox: a mesma em todas as instâncias. */
  readonly consumerName: string;
  readonly waitTimeSeconds: number;
  readonly batchSize: number;
  /** Igual ao `maxReceiveCount` do redrive: na última tentativa a mensagem vai para a DLQ com o motivo. */
  readonly maxReceiveCount: number;
  readonly retryBaseDelaySeconds: number;
  readonly shutdownGraceMs: number;
  /** Quanto tempo parar de receber quando o banco cai, para não gastar tentativas à toa. */
  readonly unavailablePauseMs?: number;
  /** Ponto de injeção de falha para testes: roda depois do commit e antes do ack. */
  readonly beforeAck?: (() => Promise<void>) | undefined;
}

/** O que o consumer conta (o PrometheusMetrics atende a esta interface). */
export interface ConsumerMetrics {
  transactionDecided(kind: string, status: string, source: 'sqs', replay: boolean): void;
  observeProcessing(source: 'sqs', seconds: number): void;
  retryScheduled(component: string, reason: string): void;
  deadLettered(reason: string): void;
}

const NO_METRICS: ConsumerMetrics = {
  transactionDecided: () => {},
  observeProcessing: () => {},
  retryScheduled: () => {},
  deadLettered: () => {},
};

export type MessageDisposition =
  | { readonly kind: 'ack' }
  | { readonly kind: 'retry'; readonly reason: string; readonly pause: boolean }
  | { readonly kind: 'dead-letter'; readonly reason: string; readonly detail: string };

/** Limite do SQS para a visibilidade de uma mensagem. */
const MAX_VISIBILITY_SECONDS = 12 * 60 * 60;

/**
 * Consumidor de `wager-transactions.fifo` (seção 10). Usa o mesmo use case da API, deduplica pela
 * inbox na mesma transação do efeito e só faz ack depois do commit. Mensagens de grupos diferentes
 * são processadas em paralelo; as do mesmo grupo (mesma wallet), em ordem.
 */
export class WagerTransactionConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private receiving: AbortController | undefined;
  private pausedUntil = 0;
  private readonly sleeper = new Sleeper();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly submit: SubmitWagerTransaction,
    private readonly options: WagerConsumerOptions,
    private readonly logger: AppLogger,
    private readonly metrics: ConsumerMetrics = NO_METRICS,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
    this.logger.info({ queue: this.options.queueName }, 'consumer started');
  }

  /**
   * Para de receber na hora (cancela o long polling), espera as mensagens em andamento terminarem
   * dentro do grace period e devolve a visibilidade das que nem começaram.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.receiving?.abort();
    this.sleeper.interrupt();
    await Promise.race([this.loop, Bun.sleep(this.options.shutdownGraceMs)]);
    this.logger.info({ queue: this.options.queueName }, 'consumer stopped');
  }

  /** Uma rodada: recebe um lote e trata cada mensagem. Devolve quantas mensagens chegaram. */
  async pollOnce(): Promise<number> {
    const queueUrl = await this.queues.get(this.options.queueName);
    this.receiving = new AbortController();
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.receiving.signal },
    );
    const messages = response.Messages ?? [];
    await this.handleBatch(queueUrl, messages);
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      const pause = this.pausedUntil - Date.now();
      if (pause > 0) {
        await this.sleeper.sleep(pause);
        continue;
      }
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.logger.warn({ err: error }, 'sqs receive failed');
        await this.sleeper.sleep(1_000);
      }
    }
  }

  private async handleBatch(queueUrl: string, messages: readonly Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? '';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const [index, message] of group.entries()) {
          if (!this.running && this.loop !== undefined) {
            // desligando: o que não começou volta para a fila agora
            await this.release(queueUrl, group.slice(index));
            return;
          }
          const disposition = await this.handle(queueUrl, message);
          if (disposition.kind === 'retry') {
            // mantém a ordem do grupo: as seguintes esperam a que vai ser repetida
            await this.release(queueUrl, group.slice(index + 1));
            return;
          }
        }
      }),
    );
  }

  private async handle(queueUrl: string, message: Message): Promise<MessageDisposition> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const parsed = parseMessage(message.Body);
    if (!parsed.ok) {
      const disposition = { kind: 'dead-letter', reason: 'INVALID_MESSAGE', detail: parsed.error } as const;
      await this.deadLetter(queueUrl, message, disposition, receiveCount);
      return disposition;
    }
    const envelope = parsed.message;
    return runWithLogContext(
      {
        messageId: envelope.messageId,
        correlationId: envelope.messageId,
        providerId: envelope.data.providerId,
        walletId: envelope.data.walletId,
      },
      async () => {
        let disposition = await this.process(envelope);
        if (disposition.kind === 'retry' && receiveCount >= this.options.maxReceiveCount) {
          disposition = { kind: 'dead-letter', reason: 'RETRIES_EXHAUSTED', detail: disposition.reason };
        }
        switch (disposition.kind) {
          case 'ack':
            await this.options.beforeAck?.();
            await this.sqs.send(
              new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
            );
            break;
          case 'retry':
            await this.retryLater(queueUrl, message, receiveCount, disposition);
            break;
          case 'dead-letter':
            await this.deadLetter(queueUrl, message, disposition, receiveCount);
            break;
        }
        return disposition;
      },
    );
  }

  private async process(envelope: WagerTransactionRequestedMessage): Promise<MessageDisposition> {
    try {
      const { data } = envelope;
      const startedAt = performance.now();
      const result = await this.submit.execute({
        ...data,
        money: Money.from(data.money),
        correlationId: envelope.messageId,
        message: {
          consumerName: this.options.consumerName,
          messageId: envelope.messageId,
          payloadHash: messagePayloadHash(envelope),
        },
      });
      this.metrics.observeProcessing('sqs', (performance.now() - startedAt) / 1_000);
      this.metrics.transactionDecided(data.kind, result.status, 'sqs', result.idempotentReplay);
      this.logger.info(
        {
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
          idempotentReplay: result.idempotentReplay,
        },
        'wager message processed',
      );
      return { kind: 'ack' };
    } catch (error) {
      return classify(error);
    }
  }

  private async retryLater(
    queueUrl: string,
    message: Message,
    receiveCount: number,
    disposition: Extract<MessageDisposition, { kind: 'retry' }>,
  ): Promise<void> {
    const delay = Math.min(
      this.options.retryBaseDelaySeconds * 2 ** (receiveCount - 1),
      MAX_VISIBILITY_SECONDS,
    );
    if (disposition.pause) {
      this.pausedUntil = Date.now() + (this.options.unavailablePauseMs ?? 5_000);
    }
    this.metrics.retryScheduled('consumer', disposition.reason);
    this.logger.warn(
      { reason: disposition.reason, receiveCount, retryInSeconds: delay },
      'wager message will be retried',
    );
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
  }

  /** Copia para a DLQ com o motivo e só então remove da fila de origem (nunca perde a mensagem). */
  private async deadLetter(
    queueUrl: string,
    message: Message,
    disposition: Extract<MessageDisposition, { kind: 'dead-letter' }>,
    receiveCount: number,
  ): Promise<void> {
    const dlqUrl = await this.queues.get(this.options.dlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          'dlq-reason': { DataType: 'String', StringValue: disposition.reason },
          'dlq-detail': { DataType: 'String', StringValue: disposition.detail.slice(0, 1_000) || '-' },
          'source-message-id': { DataType: 'String', StringValue: message.MessageId ?? '-' },
          'receive-count': { DataType: 'Number', StringValue: String(receiveCount) },
        },
      }),
    );
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
    this.metrics.deadLettered(disposition.reason);
    this.logger.error(
      { reason: disposition.reason, receiveCount },
      'wager message moved to the dead-letter queue',
    );
  }

  private async release(queueUrl: string, messages: readonly Message[]): Promise<void> {
    await Promise.all(
      messages.map((message) =>
        this.sqs
          .send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          )
          .catch((error: unknown) => this.logger.warn({ err: error }, 'could not release message')),
      ),
    );
  }
}

/**
 * Negócio (inclusive rejeição) é ack; contrato inválido, conflito e invariante quebrada nunca vão dar
 * certo, então vão direto para a DLQ; falha transitória e erro inesperado são repetidos com backoff.
 */
export function classify(error: unknown): MessageDisposition {
  if (error instanceof InvalidMoneyError || error instanceof InvalidWagerTransactionError) {
    return { kind: 'dead-letter', reason: 'INVALID_MESSAGE', detail: error.message };
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof InboxPayloadMismatchError ||
    error instanceof WalletNotFoundError ||
    error instanceof PersistenceInvariantError
  ) {
    return { kind: 'dead-letter', reason: error.code, detail: error.message };
  }
  if (error instanceof TransientInfrastructureError) {
    return { kind: 'retry', reason: `${error.code}:${error.reason}`, pause: error.reason === 'CONNECTION' };
  }
  if (error instanceof ConcurrencyConflictError) {
    return { kind: 'retry', reason: error.code, pause: false };
  }
  return { kind: 'retry', reason: 'UNEXPECTED_ERROR', pause: false };
}

type ParsedMessage =
  | { readonly ok: true; readonly message: WagerTransactionRequestedMessage }
  | { readonly ok: false; readonly error: string };

function parseMessage(body: string | undefined): ParsedMessage {
  if (body === undefined || body === '') {
    return { ok: false, error: 'mensagem sem corpo' };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'o corpo não é JSON' };
  }
  const result = wagerTransactionRequestedMessage.safeParse(json);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: z.prettifyError(result.error).slice(0, 1_000) };
}

/** Hash do conteúdo da mensagem (tipo e dados), sem os metadados de transporte. */
export function messagePayloadHash(message: WagerTransactionRequestedMessage): string {
  const canonical = canonicalJson({
    type: message.type,
    data: { ...message.data, money: { ...message.data.money } },
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
