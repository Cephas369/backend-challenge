import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet, type WalletView } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet } from '../../src/application/wallets/wallet-queries';
import { Money } from '../../src/domain/money/money';
import { systemClock, uuidV7Generator } from '../../src/infrastructure/runtime';
import { reconciliationResponse } from '../../src/interfaces/http/views';
import { createMigratedDatabase, type MigratedDatabase } from './database';
import { uuid } from './persistence';
import { type AppProcess, spawnApp } from './process';
import { createTestQueues, createTestSqsClient, type TestQueues, uniqueQueueTopology } from './sqs';

export interface ClusterInstance {
  readonly app: AppProcess;
  readonly baseUrl: string;
}

export interface SubmitOutcome {
  readonly status: number | 'connection-error';
  readonly body: Record<string, unknown>;
}

/**
 * Vários processos reais da aplicação (todos os papéis) sobre o mesmo banco e as mesmas filas,
 * exclusivos do teste. A visibilidade curta (2 s) faz a redelivery depois de uma queda ser rápida.
 */
export async function createCluster(label: string) {
  const db: MigratedDatabase = await createMigratedDatabase(label);
  const sqs: SQSClient = createTestSqsClient();
  const queues: TestQueues = await createTestQueues(
    sqs,
    uniqueQueueTopology(label, { visibilityTimeoutSeconds: 2, maxReceiveCount: 10 }),
  );
  const running: ClusterInstance[] = [];
  const createWallet = new CreateWallet(db.unitOfWork, systemClock, uuidV7Generator);
  const reconcile = new ReconcileWallet(db.unitOfWork);

  const environment: Record<string, string> = {
    PORT: '0',
    LOG_LEVEL: 'info',
    APP_ROLES: 'api,consumer,outbox,pending-ref',
    DATABASE_URL: db.database.url,
    DATABASE_POOL_MAX: '5',
    SQS_WAGER_QUEUE: queues.topology.wagerQueue,
    SQS_WAGER_DLQ: queues.topology.wagerDlq,
    SQS_EVENTS_QUEUE: queues.topology.eventsQueue,
    SQS_MAX_RECEIVE_COUNT: '10',
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_DELAY_SECONDS: '1',
    OUTBOX_IDLE_DELAY_MS: '100',
    PENDING_REFERENCE_IDLE_DELAY_MS: '100',
    REFERENCE_RETRY_INITIAL_DELAY_MS: '100',
    REFERENCE_RETRY_MAX_DELAY_MS: '500',
    SHUTDOWN_GRACE_MS: '3000',
  };

  async function start(count: number, overrides: Record<string, string> = {}): Promise<ClusterInstance[]> {
    const started = await Promise.all(
      Array.from({ length: count }, async () => {
        const app = spawnApp({ ...environment, ...overrides });
        const listening = await app.waitForLog(
          (line) => line.msg === 'http server listening',
          'instância no ar',
          20_000,
        );
        return { app, baseUrl: `http://127.0.0.1:${listening.port}` };
      }),
    );
    running.push(...started);
    return started;
  }

  async function submit(
    instance: ClusterInstance,
    body: Record<string, unknown>,
    key: string,
  ): Promise<SubmitOutcome> {
    try {
      const response = await fetch(`${instance.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } catch {
      // a instância morreu com o pedido em voo: o desfecho é desconhecido para o cliente
      return { status: 'connection-error', body: {} };
    }
  }

  return {
    db,
    sqs,
    queues,
    start,
    submit,
    createWallet: (initialBalance: string): Promise<WalletView> =>
      createWallet.execute({
        playerId: uuid(),
        initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
        correlationId: uuid(),
      }),
    /** Relatório no mesmo formato da API (dinheiro como MoneyProps). */
    reconcile: async (walletId: string) => reconciliationResponse(await reconcile.execute(walletId)),
    async sendMessage(envelope: { messageId: string; data: { walletId: string } }): Promise<void> {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queues.urls.wagerQueueUrl,
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: envelope.data.walletId,
          MessageDeduplicationId: envelope.messageId,
        }),
      );
    },
    /** Mata as instâncias em execução e espera os processos terminarem. */
    async kill(
      signal: 'SIGKILL' | 'SIGTERM',
      instances: readonly ClusterInstance[] = running,
    ): Promise<void> {
      const targets = [...instances];
      for (const instance of targets) {
        instance.app.process.kill(signal);
      }
      await Promise.all(targets.map((instance) => instance.app.process.exited));
      for (const instance of targets) {
        running.splice(running.indexOf(instance), 1);
      }
    },
    async count(sql: string, params: unknown[] = []): Promise<number> {
      const [row] = await db.orm.em.fork().execute<{ total: number }[]>(sql, params);
      return row?.total ?? 0;
    },
    async close(): Promise<void> {
      await Promise.all(
        running.splice(0).map(async (instance) => {
          instance.app.process.kill('SIGKILL');
          await instance.app.process.exited;
        }),
      );
      await queues.drop();
      sqs.destroy();
      await db.close();
    },
  };
}

export type Cluster = Awaited<ReturnType<typeof createCluster>>;
