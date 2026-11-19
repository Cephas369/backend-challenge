import { afterEach, describe, expect, test } from 'bun:test';
import type { WalletView } from '../../src/application/wallets/create-wallet';
import { type Cluster, type ClusterInstance, createCluster, type SubmitOutcome } from '../support/cluster';
import { uuid } from '../support/persistence';
import { waitFor } from '../support/wait';

/*
 * Cenários 4, 5 e 8 da seção 13 com processos reais: várias instâncias da aplicação disputando o
 * mesmo banco e as mesmas filas, inclusive morrendo no meio do caminho.
 */

let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.close();
  cluster = undefined;
});

const one = { amount: '1.00', currency: 'BRL' };

function wager(wallet: WalletView, providerId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId,
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: one,
    ...overrides,
  };
}

function message(wallet: WalletView, overrides: Record<string, unknown> = {}) {
  const data = wager(wallet, 'provider-sqs', overrides);
  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
  };
}

/** Como um provedor faria: reenvia com a mesma key enquanto a resposta for transitória ou desconhecida. */
async function submitUntilDecided(
  current: Cluster,
  instances: readonly ClusterInstance[],
  body: Record<string, unknown>,
  key: string,
): Promise<SubmitOutcome> {
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await current.submit(instances[attempt % instances.length] as ClusterInstance, body, key);
    if (outcome.status !== 503 && outcome.status !== 'connection-error') {
      return outcome;
    }
    if (attempt > 20) {
      throw new Error(`sem resposta definitiva para ${key}`);
    }
    await Bun.sleep(100);
  }
}

async function waitUntilSettled(current: Cluster, expectedProcessed: number): Promise<void> {
  await waitFor(
    async () => {
      const processed = await current.count(
        "select count(*)::int as total from wager_transactions where status = 'PROCESSED' and provider_id <> 'system'",
      );
      const pendingOutbox = await current.count(
        'select count(*)::int as total from outbox_messages where published_at is null',
      );
      return processed === expectedProcessed && pendingOutbox === 0 ? true : undefined;
    },
    {
      description: `${expectedProcessed} transações processadas e outbox vazia`,
      timeoutMs: 45_000,
      intervalMs: 200,
    },
  );
}

describe('múltiplas instâncias', () => {
  test('cenário 4: três processos com HTTP e SQS nas mesmas wallets mantêm as invariantes', async () => {
    cluster = await createCluster('cluster_three');
    const instances = await cluster.start(3);
    const wallets = await Promise.all(
      Array.from({ length: 4 }, () => (cluster as Cluster).createWallet('1000.00')),
    );

    // 30 apostas por wallet via HTTP, espalhadas pelas três instâncias; 1/3 delas enviada também a outra
    // instância ao mesmo tempo, com a mesma key
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 30 }, () => wager(wallet, 'provider-http')),
    );
    const sqsMessages = wallets.flatMap((wallet) => Array.from({ length: 15 }, () => message(wallet)));
    for (const envelope of sqsMessages) {
      await cluster.sendMessage(envelope);
    }
    const outcomes = await Promise.all(
      requests.flatMap((body, index) => {
        const key = `provider-http:${body.externalTransactionId}`;
        const primary = submitUntilDecided(
          cluster as Cluster,
          [instances[index % 3] as ClusterInstance],
          body,
          key,
        );
        return index % 3 === 0
          ? [
              primary,
              submitUntilDecided(
                cluster as Cluster,
                [instances[(index + 1) % 3] as ClusterInstance],
                body,
                key,
              ),
            ]
          : [primary];
      }),
    );

    expect(outcomes.every((outcome) => outcome.status === 201)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.body.idempotentReplay === false)).toHaveLength(
      requests.length,
    );
    await waitUntilSettled(cluster, requests.length + sqsMessages.length);
    for (const wallet of wallets) {
      expect(await cluster.reconcile(wallet.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: '955.00' },
        checkedEntries: 46,
      });
    }
    const consumersThatWorked = instances.filter((instance) =>
      instance.app.logs.some((line) => line.msg === 'wager message processed'),
    );
    expect(consumersThatWorked.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test('cenário 5: processo morto depois do commit e antes do ack — a redelivery cai na inbox', async () => {
    cluster = await createCluster('cluster_crash');
    const wallet = await cluster.createWallet('100.00');
    const [doomed] = await cluster.start(1, {
      APP_ROLES: 'consumer',
      FAULT_INJECTION: 'crash-after-commit-before-ack',
    });
    const envelope = message(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    await cluster.sendMessage(envelope);
    const exitCode = await (doomed as ClusterInstance).app.process.exited;

    expect(exitCode).toBe(137);
    expect(
      await cluster.count(
        "select count(*)::int as total from wager_transactions where status = 'PROCESSED' and provider_id = 'provider-sqs'",
      ),
    ).toBe(1);

    const [survivor] = await cluster.start(1, { APP_ROLES: 'consumer' });
    const redelivered = await (survivor as ClusterInstance).app.waitForLog(
      (line) => line.msg === 'wager message processed' && line.messageId === envelope.messageId,
      'redelivery processada pela outra instância',
      20_000,
    );

    expect(redelivered.idempotentReplay).toBe(true);
    expect(await cluster.reconcile(wallet.id)).toMatchObject({
      consistent: true,
      storedBalance: { amount: '75.00' },
      checkedEntries: 2,
    });
  }, 90_000);

  test('cenário 8: SIGKILL em todas as instâncias no meio da carga, restart e consistência final', async () => {
    cluster = await createCluster('cluster_restart');
    const wallets = await Promise.all(
      Array.from({ length: 3 }, () => (cluster as Cluster).createWallet('1000.00')),
    );
    const first = await cluster.start(3);

    // pela fila: 20 apostas por wallet, e na primeira wallet 5 REFUNDs que chegam antes das suas apostas
    const [refundWallet] = wallets as [WalletView];
    const lateBets = Array.from({ length: 5 }, () => uuid());
    for (const betId of lateBets) {
      await cluster.sendMessage(
        message(refundWallet, { kind: 'REFUND', referenceExternalTransactionId: betId }),
      );
    }
    for (const wallet of wallets) {
      for (let index = 0; index < 20; index += 1) {
        await cluster.sendMessage(message(wallet));
      }
    }
    for (const betId of lateBets) {
      await cluster.sendMessage(message(refundWallet, { externalTransactionId: betId }));
    }

    // pela API: 30 apostas por wallet, disparadas enquanto as instâncias são derrubadas
    const requests = wallets.flatMap((wallet) =>
      Array.from({ length: 30 }, () => wager(wallet, 'provider-http')),
    );
    const inFlight = Promise.all(
      requests.map((body, index) =>
        (cluster as Cluster).submit(
          first[index % 3] as ClusterInstance,
          body,
          `provider-http:${body.externalTransactionId}`,
        ),
      ),
    );
    await Bun.sleep(150);
    await cluster.kill('SIGKILL');
    const beforeCrash = await inFlight;

    // restart: o cliente reenvia o que não teve resposta definitiva, com a mesma key
    const second = await cluster.start(3);
    const afterRestart = await Promise.all(
      requests.map((body) =>
        submitUntilDecided(cluster as Cluster, second, body, `provider-http:${body.externalTransactionId}`),
      ),
    );

    expect(beforeCrash.some((outcome) => outcome.status === 'connection-error')).toBe(true);
    expect(afterRestart.every((outcome) => outcome.status === 201)).toBe(true);
    // fila + API: 60 + 5 + 5 pela fila e 90 pela API, cada uma aplicada uma única vez
    await waitUntilSettled(cluster, 60 + 5 + 5 + 90);
    expect(
      await cluster.count(
        "select count(*)::int as total from wager_transactions where status = 'PENDING_REFERENCE'",
      ),
    ).toBe(0);
    for (const wallet of wallets) {
      expect(await cluster.reconcile(wallet.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: '950.00' },
      });
    }
  }, 150_000);
});
