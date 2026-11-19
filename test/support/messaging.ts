import { createHash } from 'node:crypto';
import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  type EventPublisher,
  PublishOutboxBatch,
  type PublishOutboxOptions,
} from '../../src/application/messaging/publish-outbox';
import type { UnitOfWork } from '../../src/application/ports/persistence';
import { ReprocessPendingReferences } from '../../src/application/wagering/reprocess-pending-references';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../src/application/wagering/submit-wager-transaction';
import { CreateWallet, type WalletView } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet, type ReconciliationReport } from '../../src/application/wallets/wallet-queries';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { Money } from '../../src/domain/money/money';
import {
  ReferenceRetryPolicy,
  type ReferenceRetryPolicyOptions,
} from '../../src/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { createLogger } from '../../src/infrastructure/observability/logger';
import { systemClock, uuidV7Generator } from '../../src/infrastructure/runtime';
import { QueueUrls } from '../../src/infrastructure/sqs/queue-urls';
import { SqsEventPublisher } from '../../src/infrastructure/sqs/sqs-event-publisher';
import {
  type WagerConsumerOptions,
  WagerTransactionConsumer,
} from '../../src/interfaces/messaging/wager-transaction-consumer';
import { createMigratedDatabase, type MigratedDatabase } from './database';
import { uuid } from './persistence';
import { createTestQueues, createTestSqsClient, type TestQueues, uniqueQueueTopology } from './sqs';

export const CONSUMER_NAME = 'wagering-processor';
const silent = createLogger({ level: 'silent' });

export interface HarnessOptions {
  readonly maxReceiveCount?: number;
  readonly referenceRetry?: Partial<ReferenceRetryPolicyOptions>;
}

/** Mensagem `WagerTransactionRequested` válida; os testes sobrescrevem o que interessa. */
export function wagerMessage(
  wallet: WalletView,
  overrides: { messageId?: string; data?: Record<string, unknown> } = {},
) {
  const externalTransactionId = (overrides.data?.externalTransactionId as string | undefined) ?? uuid();
  return {
    messageId: overrides.messageId ?? `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides.data,
    },
  };
}

export type MessagingHarness = Awaited<ReturnType<typeof createMessagingHarness>>;

/**
 * PostgreSQL e SQS reais, com banco e filas exclusivos da suíte, e os componentes montados com as
 * portas de verdade. Os componentes são instanciados direto (sem Nest) para os testes controlarem
 * tempo e falhas; o `pollOnce()` do consumer deixa cada rodada determinística.
 */
export async function createMessagingHarness(label: string, options: HarnessOptions = {}) {
  const db: MigratedDatabase = await createMigratedDatabase(label);
  const sqs: SQSClient = createTestSqsClient();
  const queues: TestQueues = await createTestQueues(
    sqs,
    uniqueQueueTopology(label, {
      maxReceiveCount: options.maxReceiveCount ?? 5,
      visibilityTimeoutSeconds: 30,
    }),
  );
  const queueUrls = new QueueUrls(sqs);
  const policy = new ReferenceRetryPolicy({
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    ttlMs: 15 * 60_000,
    ...options.referenceRetry,
  });
  const settlement = new WagerSettlement(policy);
  const submitWith = (unitOfWork: UnitOfWork) =>
    new SubmitWagerTransaction(unitOfWork, settlement, systemClock, uuidV7Generator);
  const submit = submitWith(db.unitOfWork);
  const createWallet = new CreateWallet(db.unitOfWork, systemClock, uuidV7Generator);
  const reconcileWallet = new ReconcileWallet(db.unitOfWork);

  async function receiveAll(queueUrl: string): Promise<Message[]> {
    const received: Message[] = [];
    for (;;) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      if (Messages.length === 0) {
        return received;
      }
      for (const message of Messages) {
        received.push(message);
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
      }
    }
  }

  const harness = {
    db,
    sqs,
    queues,
    queueUrls,
    settlement,
    submit,
    submitWith,
    createWallet: (initialBalance = '100.00') =>
      createWallet.execute({
        playerId: uuid(),
        initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
        correlationId: uuid(),
      }),
    command(
      wallet: WalletView,
      overrides: Partial<SubmitWagerTransactionCommand> = {},
    ): SubmitWagerTransactionCommand {
      const externalTransactionId = overrides.externalTransactionId ?? uuid();
      return {
        providerId: 'provider-a',
        externalTransactionId,
        idempotencyKey: `provider-a:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        correlationId: uuid(),
        ...overrides,
      };
    },
    consumer(overrides: Partial<WagerConsumerOptions> = {}, unitOfWork: UnitOfWork = db.unitOfWork) {
      return new WagerTransactionConsumer(
        sqs,
        queueUrls,
        submitWith(unitOfWork),
        {
          queueName: queues.topology.wagerQueue,
          dlqName: queues.topology.wagerDlq,
          consumerName: CONSUMER_NAME,
          waitTimeSeconds: 1,
          batchSize: 10,
          maxReceiveCount: options.maxReceiveCount ?? 5,
          retryBaseDelaySeconds: 1,
          shutdownGraceMs: 5_000,
          ...overrides,
        },
        silent,
      );
    },
    publisher(overrides: Partial<PublishOutboxOptions> = {}, eventPublisher?: EventPublisher) {
      return new PublishOutboxBatch(
        db.unitOfWork,
        eventPublisher ?? new SqsEventPublisher(sqs, queueUrls, queues.topology.eventsQueue, 3_000),
        systemClock,
        { batchSize: 10, ...overrides },
      );
    },
    reprocessor(overrides: { settlement?: WagerSettlement; batchSize?: number } = {}) {
      return new ReprocessPendingReferences(
        db.unitOfWork,
        overrides.settlement ?? settlement,
        systemClock,
        uuidV7Generator,
        { batchSize: overrides.batchSize ?? 20, leaseMs: 30_000 },
      );
    },
    /** Envia para a fila de entrada; cada envio tem dedup id próprio (simula redelivery e republicação). */
    async send(
      body: unknown,
      sendOptions: { groupId?: string; deduplicationId?: string } = {},
    ): Promise<void> {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      const walletId = (body as { data?: { walletId?: string } } | null)?.data?.walletId;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.urls.wagerQueueUrl,
          MessageBody: text,
          MessageGroupId: sendOptions.groupId ?? walletId ?? 'sem-grupo',
          MessageDeduplicationId: sendOptions.deduplicationId ?? uuid(),
        }),
      );
    },
    receiveAll,
    /** Roda o consumer até a fila de entrada não devolver mais nada. */
    async drain(consumer: WagerTransactionConsumer): Promise<number> {
      let total = 0;
      for (let received = await consumer.pollOnce(); received > 0; received = await consumer.pollOnce()) {
        total += received;
      }
      return total;
    },
    transaction(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
      return db.unitOfWork.readOnly(({ transactions }) =>
        transactions.findByExternalId(providerId, externalTransactionId),
      );
    },
    async balanceOf(walletId: string): Promise<string | undefined> {
      const wallet = await db.unitOfWork.readOnly(({ wallets }) => wallets.findById(walletId));
      return wallet?.balance.toJSON().amount;
    },
    async debitsOf(walletId: string): Promise<number> {
      const entries = await db.unitOfWork.readOnly(({ ledger }) => ledger.page(walletId, { limit: 1_000 }));
      return entries.filter((entry) => entry.direction === 'DEBIT').length;
    },
    reconcile: (walletId: string): Promise<ReconciliationReport> => reconcileWallet.execute(walletId),
    async pendingOutbox(): Promise<number> {
      const [row] = await db.orm.em
        .fork()
        .execute<{ pending: number }[]>(
          'select count(*)::int as pending from outbox_messages where published_at is null',
        );
      return row?.pending ?? 0;
    },
    async outboxEventTypes(aggregateId: string): Promise<string[]> {
      const rows = await db.orm.em
        .fork()
        .execute<{ event_type: string }[]>(
          'select event_type from outbox_messages where aggregate_id = ? order by occurred_at, id',
          [aggregateId],
        );
      return rows.map((row) => row.event_type);
    },
    /** Publica tudo o que está pendente e esvazia a fila de eventos: cada teste começa do zero. */
    async flushOutbox(): Promise<void> {
      const publisher = harness.publisher();
      while ((await publisher.run()).attempted > 0) {
        // continua até não sobrar nada devido
      }
      await receiveAll(queues.urls.eventsQueueUrl);
    },
    async close(): Promise<void> {
      await queues.drop();
      sqs.destroy();
      await db.close();
    },
  };
  return harness;
}

/**
 * Consumidor de eventos de teste que monta o saldo de cada wallet a partir de `WalletBalanceChanged`,
 * deduplicando por eventId na inbox persistente, com o mesmo mecanismo do consumer da aplicação.
 */
export class BalanceProjection {
  private readonly balances = new Map<string, { version: number; amount: string }>();
  duplicatesIgnored = 0;

  constructor(private readonly unitOfWork: UnitOfWork) {}

  async apply(message: Message): Promise<void> {
    const envelope = JSON.parse(message.Body ?? '{}') as {
      eventId: string;
      eventType: string;
      data: { walletId: string; walletVersion: number; balanceAfter: { amount: string } };
    };
    const firstTime = await this.unitOfWork.transaction(({ inbox }) =>
      inbox.tryInsert(
        InboxMessage.receive({
          consumerName: 'balance-projection',
          messageId: envelope.eventId,
          payloadHash: createHash('sha256')
            .update(message.Body ?? '')
            .digest('hex'),
          receivedAt: new Date(),
        }),
      ),
    );
    if (!firstTime) {
      this.duplicatesIgnored += 1;
      return;
    }
    if (envelope.eventType !== 'WalletBalanceChanged') {
      return;
    }
    const current = this.balances.get(envelope.data.walletId);
    // a versão ordena os eventos da wallet mesmo se chegarem fora de ordem
    if (current === undefined || envelope.data.walletVersion > current.version) {
      this.balances.set(envelope.data.walletId, {
        version: envelope.data.walletVersion,
        amount: envelope.data.balanceAfter.amount,
      });
    }
  }

  balanceOf(walletId: string): string | undefined {
    return this.balances.get(walletId)?.amount;
  }
}
