import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiResponse, type SubmitBody, startTestApi, type TestApi, wagerBody } from '../support/api';
import { latch } from '../support/wait';

/*
 * Paralelismo real: requisições HTTP simultâneas contra a aplicação inteira e o PostgreSQL de verdade.
 * Sem mocks e sem serializar no teste. Quem serializa (ou não) é o lock da wallet no banco.
 */

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi('concurrency');
});

afterAll(async () => {
  await api?.close();
});

interface LedgerBody {
  readonly items: { direction: string }[];
}

async function debitsOf(target: TestApi, walletId: string): Promise<number> {
  const ledger = await target.request<LedgerBody>('GET', `/wallets/${walletId}/ledger?limit=100`);
  return ledger.body.items.filter((item) => item.direction === 'DEBIT').length;
}

const money = (amount: string) => ({ amount, currency: 'BRL' });

describe('concorrência na mesma wallet', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wagerBody(wallet, { money: money('25.00') });

    const responses = await Promise.all(Array.from({ length: 50 }, () => api.submit(bet)));

    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(201));
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(await debitsOf(api, wallet.id)).toBe(1);
    expect(await api.reconcile(wallet.id)).toMatchObject({
      consistent: true,
      storedBalance: { amount: '75.00' },
    });
  });

  test('cenário da seção 8: 100.00 e duas apostas de 80.00 simultâneas (20 rodadas)', async () => {
    for (let round = 0; round < 20; round += 1) {
      const wallet = await api.createWallet('100.00');

      const results: ApiResponse<SubmitBody>[] = await Promise.all([
        api.submit(wagerBody(wallet, { money: money('80.00') })),
        api.submit(wagerBody(wallet, { money: money('80.00') })),
      ]);

      const statuses = results.map((response) => response.body.status).sort();
      expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
      expect(results.find((response) => response.status === 422)?.body.failureCode).toBe(
        'INSUFFICIENT_FUNDS',
      );
      expect(await debitsOf(api, wallet.id)).toBe(1);
      expect(await api.reconcile(wallet.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: '20.00' },
      });
    }
  });
});

describe('concorrência entre wallets', () => {
  test('wallets distintas processam em paralelo e todas fecham com o ledger', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => api.createWallet('100.00')));

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 10 }, () => api.submit(wagerBody(wallet, { money: money('1.00') }))),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const wallet of wallets) {
      expect(await api.reconcile(wallet.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: '90.00' },
        checkedEntries: 11,
      });
    }
  });

  test('não há lock global: com a wallet A travada, a B processa; A falha de forma transitória e o reenvio funciona', async () => {
    const impatient = await startTestApi('concurrency_lock', { lockTimeoutMs: 300 });
    try {
      const walletA = await impatient.createWallet('100.00');
      const walletB = await impatient.createWallet('100.00');
      const betOnA = wagerBody(walletA, { money: money('10.00') });
      const locked = latch();
      const mayRelease = latch();

      // outra sessão segura a linha da wallet A, como faria uma transação longa
      const holder = impatient.db.orm.em.fork().transactional(async (em) => {
        await em.execute('select id from wallets where id = ? for update', [walletA.id]);
        locked.release();
        await mayRelease.promise;
      });
      await locked.promise;

      const onB = await impatient.submit(wagerBody(walletB, { money: money('10.00') }));
      const onA = await impatient.submit(betOnA);
      mayRelease.release();
      await holder;
      const retried = await impatient.submit(betOnA);

      expect(onB.status).toBe(201);
      expect(onA.status).toBe(503);
      expect(onA.body as unknown).toMatchObject({ code: 'LOCK_TIMEOUT', retryable: true });
      expect(onA.headers.get('retry-after')).toBe('1');
      expect(retried.status).toBe(201);
      // a tentativa que falhou não deixou rastro: o reenvio é o primeiro processamento
      expect(retried.body.idempotentReplay).toBe(false);
      expect(await impatient.reconcile(walletA.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: '90.00' },
      });
    } finally {
      await impatient.close();
    }
  });
});
