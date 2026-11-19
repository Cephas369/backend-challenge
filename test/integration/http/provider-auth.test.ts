import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ProviderAuthenticationError,
  type ProviderIdentityPort,
} from '../../../src/application/ports/provider-identity';
import { type SubmitBody, startTestApi, type TestApi, type WalletBody, wagerBody } from '../../support/api';

/**
 * O ponto de extensão da autenticação (D26) com uma identidade de mentira no lugar do IdP: o header
 * `x-test-provider` faz o papel do token já validado. A aplicação real sobe sem autenticação.
 */
const headerIdentity: ProviderIdentityPort = {
  async identify(headers) {
    const providerId = headers['x-test-provider'];
    if (typeof providerId !== 'string') {
      throw new ProviderAuthenticationError('credencial ausente');
    }
    return { providerId };
  },
};

const as = (providerId: string) => ({ 'x-test-provider': providerId });

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi('provider_auth', { providerIdentity: headerIdentity });
});

afterAll(async () => {
  await api?.close();
});

async function balanceOf(wallet: WalletBody): Promise<unknown> {
  return (await api.request<WalletBody>('GET', `/wallets/${wallet.id}`)).body.balance;
}

describe('autenticação de provedor (ponto de extensão)', () => {
  test('sem credencial: 401 com WWW-Authenticate, antes de validar o pedido, e nada é gravado', async () => {
    const wallet = await api.createWallet('100.00');

    const refused = await api.request('POST', '/wagering/transactions', {
      body: wagerBody(wallet),
      headers: { 'idempotency-key': 'auth-1' },
    });
    const invalid = await api.request('POST', '/wagering/transactions', { body: {} });

    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: 'UNAUTHENTICATED', retryable: false });
    expect(refused.headers.get('www-authenticate')).toBe('Bearer');
    expect(invalid.status).toBe(401);
    expect(await balanceOf(wallet)).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('um provedor só opera em nome de si mesmo: 403 PROVIDER_MISMATCH sem deixar rastro', async () => {
    const wallet = await api.createWallet('100.00');
    const body = wagerBody(wallet, { providerId: 'provider-a' });

    const refused = await api.request('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': 'auth-2', ...as('provider-b') },
    });
    const accepted = await api.request<SubmitBody>('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': 'auth-2', ...as('provider-a') },
    });

    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'PROVIDER_MISMATCH' });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  test('consultas: o espaço de outro provedor dá 403 e o id dele dá 404, sem revelar que existe', async () => {
    const wallet = await api.createWallet('100.00');
    const body = wagerBody(wallet, { providerId: 'provider-a' });
    const created = await api.request<SubmitBody>('POST', '/wagering/transactions', {
      body,
      headers: { 'idempotency-key': 'auth-3', ...as('provider-a') },
    });
    const byExternalId = `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`;
    const byId = `/wagering/transactions/${created.body.transactionId}`;

    expect((await api.request('GET', byExternalId, { headers: as('provider-a') })).status).toBe(200);
    expect((await api.request('GET', byId, { headers: as('provider-a') })).status).toBe(200);

    const foreignNamespace = await api.request('GET', byExternalId, { headers: as('provider-b') });
    const foreignId = await api.request('GET', byId, { headers: as('provider-b') });
    expect(foreignNamespace.status).toBe(403);
    expect(foreignNamespace.body).toMatchObject({ code: 'PROVIDER_MISMATCH' });
    expect(foreignId.status).toBe(404);
    expect(foreignId.body).toMatchObject({ code: 'TRANSACTION_NOT_FOUND' });
    expect((await api.request('GET', byId)).status).toBe(401);
  });

  test('health e métricas continuam abertos', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/metrics`)).status).toBe(200);
  });
});
