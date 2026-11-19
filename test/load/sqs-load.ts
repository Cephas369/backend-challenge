import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MigratedDatabase } from '../support/database';
import { type LatencySummary, summarize } from './stats';
import type { WalletRef } from './workload';

export interface SqsScenarioOptions {
  readonly sqs: SQSClient;
  readonly queueUrl: string;
  readonly db: MigratedDatabase;
  readonly wallets: readonly WalletRef[];
  readonly messages: number;
  /** Fração das mensagens publicadas de novo com o mesmo `messageId`, como numa redelivery. */
  readonly duplicateRate: number;
  /** Envios de lote simultâneos. */
  readonly senders: number;
  readonly timeoutMs: number;
}

export interface SqsScenarioResult {
  readonly messages: number;
  readonly duplicatesSent: number;
  readonly sendSeconds: number;
  /** Do primeiro envio até a última mensagem processada. */
  readonly drainSeconds: number;
  readonly throughput: number;
  /**
   * Do envio até o início do processamento: o instante da decisão, que a inbox grava. A duração do
   * processamento em si vem do histograma do servidor.
   */
  readonly sentToProcessing: LatencySummary;
  readonly statuses: Record<string, number>;
  readonly windowStartedAt: Date;
  readonly windowEndedAt: Date;
  readonly expectedCents: (wallet: WalletRef) => bigint;
}

const PROVIDER = 'provider-sqs';

interface Entry {
  readonly messageId: string;
  readonly deduplicationId: string;
  readonly walletId: string;
  readonly data: Record<string, unknown>;
}

/**
 * Publica as mensagens em lotes de 10 (o máximo do SQS), com o `MessageGroupId` = wallet, e mede pela
 * inbox quando cada uma foi decidida. A duplicata vai no mesmo lote, logo depois da original, com
 * outro `MessageDeduplicationId`: a fila entrega as duas, e quem barra é a aplicação.
 */
export async function runSqsScenario(options: SqsScenarioOptions): Promise<SqsScenarioResult> {
  const deltas = new Map<string, bigint>();
  const groups: Entry[][] = [];
  let duplicatesSent = 0;
  for (let index = 0; index < options.messages; index += 1) {
    const wallet = options.wallets[index % options.wallets.length];
    if (wallet === undefined) {
      throw new Error('cenário SQS sem wallets');
    }
    const kind = Math.random() < 0.5 ? 'BET' : 'WIN';
    deltas.set(wallet.id, (deltas.get(wallet.id) ?? 0n) + (kind === 'BET' ? -100n : 100n));
    const externalTransactionId = `sqs-${index}`;
    const messageId = `msg-sqs-${index}`;
    const data = {
      providerId: PROVIDER,
      externalTransactionId,
      idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `sqs-round-${index}`,
      gameId: 'fortune-chimp',
      kind,
      money: { amount: '1.00', currency: 'BRL' },
    };
    const group: Entry[] = [{ messageId, deduplicationId: messageId, walletId: wallet.id, data }];
    if (Math.random() < options.duplicateRate) {
      group.push({ messageId, deduplicationId: `${messageId}-dup`, walletId: wallet.id, data });
      duplicatesSent += 1;
    }
    groups.push(group);
  }

  // lotes de até 10 entradas, sem separar a original da duplicata
  const batches: Entry[][] = [];
  let current: Entry[] = [];
  for (const group of groups) {
    if (current.length + group.length > 10) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) {
    batches.push(current);
  }

  const sentAt = new Map<string, number>();
  const startedAt = Date.now();
  let nextBatch = 0;
  const sender = async (): Promise<void> => {
    for (let batch = batches[nextBatch++]; batch !== undefined; batch = batches[nextBatch++]) {
      const now = Date.now();
      const occurredAt = new Date(now).toISOString();
      for (const entry of batch) {
        if (!sentAt.has(entry.messageId)) {
          sentAt.set(entry.messageId, now);
        }
      }
      const response = await options.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: options.queueUrl,
          Entries: batch.map((entry, position) => ({
            Id: `e${position}`,
            MessageBody: JSON.stringify({
              messageId: entry.messageId,
              type: 'WagerTransactionRequested',
              occurredAt,
              data: entry.data,
            }),
            MessageGroupId: entry.walletId,
            MessageDeduplicationId: entry.deduplicationId,
          })),
        }),
      );
      if ((response.Failed ?? []).length > 0) {
        throw new Error(`SendMessageBatch recusou ${response.Failed?.length} mensagens`);
      }
    }
  };
  await Promise.all(Array.from({ length: options.senders }, () => sender()));
  const sendSeconds = (Date.now() - startedAt) / 1_000;

  const em = () => options.db.orm.em.fork();
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const [row] = await em().execute<{ total: number }[]>(
      `select count(*)::int as total from inbox_messages
        where message_id like 'msg-sqs-%' and processed_at is not null`,
    );
    if ((row?.total ?? 0) >= options.messages) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`só ${row?.total ?? 0} de ${options.messages} mensagens processadas no prazo`);
    }
    await Bun.sleep(250);
  }

  const rows = await em().execute<{ message_id: string; processed_ms: string }[]>(
    `select message_id, extract(epoch from processed_at) * 1000 as processed_ms
       from inbox_messages where message_id like 'msg-sqs-%'`,
  );
  const sentToProcessing: number[] = [];
  let lastProcessed = startedAt;
  for (const row of rows) {
    const processed = Number(row.processed_ms);
    sentToProcessing.push(processed - (sentAt.get(row.message_id) ?? Number.NaN));
    lastProcessed = Math.max(lastProcessed, processed);
  }
  const statusRows = await em().execute<{ status: string; total: number }[]>(
    'select status, count(*)::int as total from wager_transactions where provider_id = ? group by status',
    [PROVIDER],
  );
  const drainSeconds = (lastProcessed - startedAt) / 1_000;

  return {
    messages: options.messages,
    duplicatesSent,
    sendSeconds,
    drainSeconds,
    throughput: options.messages / drainSeconds,
    sentToProcessing: summarize(sentToProcessing),
    statuses: Object.fromEntries(statusRows.map((row) => [row.status, row.total])),
    windowStartedAt: new Date(startedAt),
    windowEndedAt: new Date(lastProcessed),
    expectedCents: (wallet) => wallet.initialCents + (deltas.get(wallet.id) ?? 0n),
  };
}
