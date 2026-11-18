import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startTestApi, type TestApi, uuid, wagerBody } from '../../support/api';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi('wagering_api');
});

afterAll(async () => {
  await api?.close();
});

async function expectConsistent(walletId: string): Promise<void> {
  const report = await api.reconcile(walletId);
  expect(report).toMatchObject({ consistent: true, issues: [] });
}

describe('POST /wagering/transactions', () => {
  test('BET processada: 201 com o saldo observado; replay idêntico devolve o mesmo resultado', async () => {
    const wallet = await api.createWallet('1000.00');
    const body = wagerBody(wallet);

    const first = await api.submit(body);
    const replay = await api.submit(body);

    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    await expectConsistent(wallet.id);
  });

  test('replay devolve o saldo daquele momento, não o atual', async () => {
    const wallet = await api.createWallet('100.00');
    const firstBet = wagerBody(wallet, { money: { amount: '10.00', currency: 'BRL' } });
    await api.submit(firstBet);
    await api.submit(wagerBody(wallet, { money: { amount: '30.00', currency: 'BRL' } }));

    const replay = await api.submit(firstBet);

    expect(replay.body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  test('mesma key com payload diferente: 409 IDEMPOTENCY_KEY_REUSED, sem efeito', async () => {
    const wallet = await api.createWallet('100.00');
    const body = wagerBody(wallet);
    await api.submit(body);

    const conflict = await api.submit({ ...body, money: { amount: '26.00', currency: 'BRL' } });

    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('content-type')).toContain('application/problem+json');
    expect(conflict.body).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', retryable: false });
    expect((await api.request('GET', `/wallets/${wallet.id}`)).body).toMatchObject({
      balance: { amount: '75.00' },
    });
  });

  test('mesmo externalTransactionId com outra key: 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await api.createWallet('100.00');
    const body = wagerBody(wallet);
    await api.submit(body);

    const conflict = await api.submit(body, `outra-key-${uuid()}`);

    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'EXTERNAL_ID_CONFLICT' });
  });

  test('sem saldo: 422 REJECTED com INSUFFICIENT_FUNDS, e o replay devolve o mesmo 422', async () => {
    const wallet = await api.createWallet('10.00');
    const body = wagerBody(wallet, { money: { amount: '10.01', currency: 'BRL' } });

    const rejected = await api.submit(body);
    const replay = await api.submit(body);

    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
    await expectConsistent(wallet.id);
  });

  test('WIN credita, LOSS registra sem mover saldo', async () => {
    const wallet = await api.createWallet('100.00');

    const win = await api.submit(
      wagerBody(wallet, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } }),
    );
    const loss = await api.submit(
      wagerBody(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
    );

    expect(win.status).toBe(201);
    expect(win.body.balance).toEqual({ amount: '140.00', currency: 'BRL' });
    expect(loss.status).toBe(201);
    expect(loss.body.balance).toEqual({ amount: '140.00', currency: 'BRL' });
    await expectConsistent(wallet.id);
  });

  test('REFUND devolve a BET uma única vez', async () => {
    const wallet = await api.createWallet('100.00');
    const bet = wagerBody(wallet);
    await api.submit(bet);
    const refund = (amount = '25.00') =>
      wagerBody(wallet, {
        kind: 'REFUND',
        referenceExternalTransactionId: bet.externalTransactionId,
        money: { amount, currency: 'BRL' },
      });

    const first = await api.submit(refund());
    const second = await api.submit(refund());

    expect(first.status).toBe(201);
    expect(first.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await expectConsistent(wallet.id);
  });

  test('REFUND antes da BET: 202 PENDING_REFERENCE, sem mexer no saldo', async () => {
    const wallet = await api.createWallet('100.00');
    const betExternalId = uuid();

    const early = await api.submit(
      wagerBody(wallet, { kind: 'REFUND', referenceExternalTransactionId: betExternalId }),
    );

    expect(early.status).toBe(202);
    expect(early.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
    await expectConsistent(wallet.id);
  });

  test('ROLLBACK de WIN sem saldo: 422 REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await api.createWallet('0.00');
    const win = wagerBody(wallet, { kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } });
    await api.submit(win);
    await api.submit(wagerBody(wallet, { money: { amount: '30.00', currency: 'BRL' } }));

    const rollback = await api.submit(
      wagerBody(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: win.externalTransactionId,
        money: { amount: '40.00', currency: 'BRL' },
      }),
    );

    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  });

  test('moeda diferente da wallet: 422 CURRENCY_MISMATCH', async () => {
    const wallet = await api.createWallet('100.00');
    const response = await api.submit(wagerBody(wallet, { money: { amount: '10.00', currency: 'USD' } }));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('wallet inexistente: 404 WALLET_NOT_FOUND', async () => {
    const wallet = await api.createWallet('100.00');
    const response = await api.submit(wagerBody(wallet, { walletId: uuid() }));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND', retryable: false });
  });

  describe('payload inválido: 400 com código e campo', () => {
    test.each<[string, (base: Record<string, unknown>) => Record<string, unknown>, string]>([
      ['amount com uma casa', (b) => ({ ...b, money: { amount: '25.5', currency: 'BRL' } }), 'INVALID_MONEY'],
      ['amount negativo', (b) => ({ ...b, money: { amount: '-1.00', currency: 'BRL' } }), 'INVALID_MONEY'],
      ['amount como número', (b) => ({ ...b, money: { amount: 25, currency: 'BRL' } }), 'VALIDATION_FAILED'],
      ['moeda minúscula', (b) => ({ ...b, money: { amount: '1.00', currency: 'brl' } }), 'INVALID_MONEY'],
      ['OPENING', (b) => ({ ...b, kind: 'OPENING' }), 'KIND_NOT_ALLOWED'],
      ['kind desconhecido', (b) => ({ ...b, kind: 'JACKPOT' }), 'VALIDATION_FAILED'],
      ['REFUND sem referência', (b) => ({ ...b, kind: 'REFUND' }), 'REFERENCE_REQUIRED'],
      ['BET de valor zero', (b) => ({ ...b, money: { amount: '0.00', currency: 'BRL' } }), 'INVALID_AMOUNT'],
      ['walletId que não é UUID', (b) => ({ ...b, walletId: 'wallet-1' }), 'VALIDATION_FAILED'],
      ['campo desconhecido', (b) => ({ ...b, ammount: '1.00' }), 'VALIDATION_FAILED'],
      ['provider reservado', (b) => ({ ...b, providerId: 'system' }), 'RESERVED_PROVIDER'],
    ])('%s → %s', async (_case, mutate, code) => {
      const wallet = await api.createWallet('100.00');
      const body = mutate(wagerBody(wallet)) as ReturnType<typeof wagerBody>;

      const response = await api.submit(body, `key-${uuid()}`);
      const problem = response.body as unknown as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(problem).toMatchObject({ status: 400, code, retryable: false });
      expect(problem.correlationId).toEqual(expect.any(String));
    });

    test('sem Idempotency-Key → IDEMPOTENCY_KEY_REQUIRED', async () => {
      const wallet = await api.createWallet('100.00');
      const response = await api.request('POST', '/wagering/transactions', { body: wagerBody(wallet) });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    test('JSON malformado → MALFORMED_REQUEST no mesmo formato', async () => {
      const response = await api.request('POST', '/wagering/transactions', {
        rawBody: '{"providerId": ',
        headers: { 'idempotency-key': 'k-1' },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(response.body.code).toBe('MALFORMED_REQUEST');
    });
  });
});

describe('consultas de transação', () => {
  test('por id interno e por (providerId, externalTransactionId)', async () => {
    const wallet = await api.createWallet('100.00');
    const body = wagerBody(wallet);
    const { body: submitted } = await api.submit(body);

    const byId = await api.request('GET', `/wagering/transactions/${submitted.transactionId}`);
    const byExternal = await api.request(
      'GET',
      `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );

    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: submitted.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      failureCode: null,
    });
    expect(byExternal.body).toEqual(byId.body);
  });

  test('inexistente: 404 TRANSACTION_NOT_FOUND; rota desconhecida: 404 ROUTE_NOT_FOUND', async () => {
    expect((await api.request('GET', `/wagering/transactions/${uuid()}`)).body).toMatchObject({
      status: 404,
      code: 'TRANSACTION_NOT_FOUND',
    });
    expect((await api.request('GET', '/nada-aqui')).body).toMatchObject({
      status: 404,
      code: 'ROUTE_NOT_FOUND',
    });
  });
});
