import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp, listeningPort } from '../../src/bootstrap';
import { createLogger } from '../../src/infrastructure/observability/logger';
import { buildTestConfig } from './config';
import { createMigratedDatabase, type MigratedDatabase } from './database';
import { uuid } from './persistence';

export { uuid };

export interface ApiResponse<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface TestApi {
  readonly db: MigratedDatabase;
  request<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; rawBody?: string; headers?: Record<string, string> },
  ): Promise<ApiResponse<T>>;
  /** Cria uma wallet para um player novo e devolve o corpo da resposta. */
  createWallet(initialBalance?: string, currency?: string): Promise<WalletBody>;
  submit(body: WagerBody, idempotencyKey?: string): Promise<ApiResponse<SubmitBody>>;
  reconcile(walletId: string): Promise<ReconciliationBody>;
  close(): Promise<void>;
}

export interface WalletBody {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

export interface SubmitBody {
  readonly transactionId: string;
  readonly status: string;
  readonly failureCode?: string;
  readonly balance: { readonly amount: string; readonly currency: string } | null;
  readonly idempotentReplay: boolean;
}

export interface ReconciliationBody {
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly storedBalance: { readonly amount: string };
  readonly calculatedBalance: { readonly amount: string };
  readonly difference: { readonly amount: string };
  readonly issues: readonly string[];
}

export type WagerBody = Record<string, unknown> & { providerId: string; externalTransactionId: string };

/** Corpo válido de uma operação; os testes sobrescrevem o que interessa. */
export function wagerBody(wallet: WalletBody, overrides: Record<string, unknown> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: uuid(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/**
 * A aplicação em processo, contra um banco migrado próprio da suíte. Só o papel "api" é ligado:
 * consumer e workers não sobem aqui (têm testes próprios, com filas próprias).
 */
export async function startTestApi(
  label: string,
  environment: { lockTimeoutMs?: number } = {},
): Promise<TestApi> {
  const db = await createMigratedDatabase(label);
  const config = buildTestConfig({
    databaseUrl: db.database.url,
    ...(environment.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: environment.lockTimeoutMs }),
    roles: ['api'],
  });
  const app: NestExpressApplication = await createApp(config, createLogger({ level: 'silent' }));
  await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${listeningPort(app)}`;

  const request: TestApi['request'] = async (method, path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...options.headers },
      ...(options.rawBody !== undefined
        ? { body: options.rawBody }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : JSON.parse(text),
      headers: response.headers,
    } as never;
  };

  return {
    db,
    request,
    async createWallet(initialBalance = '100.00', currency = 'BRL') {
      const response = await request<WalletBody>('POST', '/wallets', {
        body: { playerId: uuid(), initialBalance: { amount: initialBalance, currency } },
      });
      if (response.status !== 201) {
        throw new Error(`criação de wallet falhou: ${response.status} ${JSON.stringify(response.body)}`);
      }
      return response.body;
    },
    submit(body, idempotencyKey = `${body.providerId}:${body.externalTransactionId}`) {
      return request<SubmitBody>('POST', '/wagering/transactions', {
        body,
        headers: { 'idempotency-key': idempotencyKey },
      });
    },
    async reconcile(walletId) {
      return (await request<ReconciliationBody>('POST', `/wallets/${walletId}/reconciliation`)).body;
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
