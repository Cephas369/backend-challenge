import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestApi, type TestApi, uuid, type WalletBody, wagerBody } from '../../support/api';
import { rawTransaction } from '../../support/persistence';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi('wallets_api');
});

afterAll(async () => {
  await api?.close();
});

interface LedgerBody {
  readonly items: { walletVersion: number; direction: string; balanceAfter: { amount: string } }[];
  readonly nextCursor: string | null;
}

describe('POST /wallets', () => {
  test('201 na versão 1; o saldo inicial gera o crédito OPENING no ledger', async () => {
    const playerId = uuid();
    const response = await api.request('POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
    });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const ledger = await api.request<LedgerBody>('GET', `/wallets/${response.body.id}/ledger`);
    expect(ledger.body.items).toMatchObject([
      { direction: 'CREDIT', walletVersion: 1, balanceAfter: { amount: '1000.00' } },
    ]);
  });

  test('saldo inicial zero: nenhum lançamento, e a reconciliação fecha', async () => {
    const wallet = await api.createWallet('0.00');

    const ledger = await api.request<LedgerBody>('GET', `/wallets/${wallet.id}/ledger`);

    expect(ledger.body).toEqual({ items: [], nextCursor: null });
    expect(await api.reconcile(wallet.id)).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  test('mesmo player e moeda: 409 WALLET_ALREADY_EXISTS; outra moeda é permitida', async () => {
    const wallet = await api.createWallet('10.00');
    const again = (currency: string) =>
      api.request('POST', '/wallets', {
        body: { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency } },
      });

    const duplicate = await again('BRL');
    const otherCurrency = await again('USD');

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: 'WALLET_ALREADY_EXISTS', retryable: false });
    expect(otherCurrency.status).toBe(201);
  });

  test('saldo inicial inválido: 400 INVALID_MONEY apontando o campo', async () => {
    const response = await api.request('POST', '/wallets', {
      body: { playerId: uuid(), initialBalance: { amount: '1e3', currency: 'BRL' } },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_MONEY',
      errors: [{ path: 'initialBalance', message: 'MALFORMED' }],
    });
  });
});

describe('GET /wallets/:walletId', () => {
  test('devolve saldo e versão; inexistente é 404 e id malformado é 400', async () => {
    const wallet = await api.createWallet('50.00');

    expect((await api.request<WalletBody>('GET', `/wallets/${wallet.id}`)).body).toEqual(wallet);
    expect((await api.request('GET', `/wallets/${uuid()}`)).body).toMatchObject({
      status: 404,
      code: 'WALLET_NOT_FOUND',
    });
    expect((await api.request('GET', '/wallets/nao-e-uuid')).body).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  test('pagina do mais recente ao mais antigo com cursor opaco e estável', async () => {
    const wallet = await api.createWallet('100.00');
    for (let bet = 0; bet < 5; bet += 1) {
      await api.submit(wagerBody(wallet, { money: { amount: '1.00', currency: 'BRL' } }));
    }

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page = await api.request<LedgerBody>('GET', `/wallets/${wallet.id}/ledger${query}`);
      expect(page.status).toBe(200);
      versions.push(...page.body.items.map((item) => item.walletVersion));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(versions).toEqual([6, 5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
  });

  test('cursor e limite inválidos: 400', async () => {
    const wallet = await api.createWallet('1.00');
    expect((await api.request('GET', `/wallets/${wallet.id}/ledger?cursor=lixo`)).body).toMatchObject({
      code: 'INVALID_CURSOR',
    });
    for (const limit of ['0', '101', 'abc']) {
      expect((await api.request('GET', `/wallets/${wallet.id}/ledger?limit=${limit}`)).status).toBe(400);
    }
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  test('consistente depois de várias operações', async () => {
    const wallet = await api.createWallet('100.00');
    await api.submit(wagerBody(wallet, { money: { amount: '30.00', currency: 'BRL' } }));
    await api.submit(wagerBody(wallet, { kind: 'WIN', money: { amount: '12.50', currency: 'BRL' } }));

    const report = await api.reconcile(wallet.id);

    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '82.50', currency: 'BRL' },
      calculatedBalance: { amount: '82.50', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
      issues: [],
    } as never);
  });

  test('detecta e sinaliza uma divergência, sem corrigir', async () => {
    const wallet = await api.createWallet('100.00');
    // adulteração de fora da aplicação, com os triggers desligados (só um superusuário consegue)
    await rawTransaction(api.db.orm, [
      ["set local session_replication_role = 'replica'"],
      ["update wallets set balance_amount = '150.00' where id = ?", [wallet.id]],
    ]);

    const report = await api.reconcile(wallet.id);
    const after = await api.request('GET', `/wallets/${wallet.id}`);

    expect(report).toMatchObject({
      consistent: false,
      storedBalance: { amount: '150.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '50.00' },
    });
    expect(report.issues.length).toBeGreaterThan(0);
    expect(after.body).toMatchObject({ balance: { amount: '150.00' } });
  });
});
