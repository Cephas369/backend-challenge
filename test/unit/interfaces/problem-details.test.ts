import { describe, expect, test } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  PersistenceInvariantError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { ProviderAuthenticationError } from '../../../src/application/ports/provider-identity';
import { InvalidMoneyError } from '../../../src/domain/money/money';
import { InvalidWagerTransactionError } from '../../../src/domain/wagering/wager-transaction';
import { problemFor } from '../../../src/interfaces/http/problem-details';
import { actsOnBehalfOf, ProviderMismatchError } from '../../../src/interfaces/http/provider-auth.guard';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseMoney,
  RequestValidationError,
} from '../../../src/interfaces/http/request-validation';

describe('mapeamento de erro para HTTP', () => {
  test.each<[string, unknown, number, string, boolean]>([
    [
      'payload inválido',
      new RequestValidationError('VALIDATION_FAILED', 'x'),
      400,
      'VALIDATION_FAILED',
      false,
    ],
    [
      'sem key',
      new RequestValidationError('IDEMPOTENCY_KEY_REQUIRED', 'x'),
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      false,
    ],
    ['dinheiro inválido', new InvalidMoneyError('TOO_MANY_DECIMALS', 'x'), 400, 'INVALID_MONEY', false],
    [
      'OPENING externo',
      new InvalidWagerTransactionError('KIND_NOT_ALLOWED', 'x'),
      400,
      'KIND_NOT_ALLOWED',
      false,
    ],
    ['campo vazio', new InvalidWagerTransactionError('MISSING_FIELD', 'x'), 400, 'VALIDATION_FAILED', false],
    ['sem credencial válida', new ProviderAuthenticationError('x'), 401, 'UNAUTHENTICATED', false],
    ['provedor diferente do autenticado', new ProviderMismatchError(), 403, 'PROVIDER_MISMATCH', false],
    ['wallet inexistente', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND', false],
    ['transação inexistente', new TransactionNotFoundError('x'), 404, 'TRANSACTION_NOT_FOUND', false],
    ['key reusada', new IdempotencyConflictError('t'), 409, 'IDEMPOTENCY_KEY_REUSED', false],
    ['externalId reusado', new ExternalTransactionConflictError('t'), 409, 'EXTERNAL_ID_CONFLICT', false],
    ['wallet duplicada', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS', false],
    ['lock demorado', new TransientInfrastructureError('LOCK_TIMEOUT', 'x'), 503, 'LOCK_TIMEOUT', true],
    ['banco fora', new TransientInfrastructureError('CONNECTION', 'x'), 503, 'DATABASE_UNAVAILABLE', true],
    ['conflito esgotado', new ConcurrencyConflictError('x'), 503, 'CONCURRENCY_CONFLICT', true],
    ['rota inexistente', new NotFoundException(), 404, 'ROUTE_NOT_FOUND', false],
    ['JSON malformado', new BadRequestException('Unexpected token'), 400, 'MALFORMED_REQUEST', false],
    ['invariante do banco', new PersistenceInvariantError('WP004', 'x'), 500, 'INTERNAL_ERROR', false],
    ['erro qualquer', new Error('boom'), 500, 'INTERNAL_ERROR', false],
  ])('%s → %i %s', (_case, error, status, code, retryable) => {
    expect(problemFor(error)).toMatchObject({ status, code, retryable });
  });

  test('erro interno não vaza a mensagem original', () => {
    expect(problemFor(new Error('senha do banco: hunter2')).detail).not.toContain('hunter2');
  });
});

describe('cursor do ledger', () => {
  test('ida e volta', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(42))).toBe(42);
  });

  test.each(['lixo', encodeLedgerCursor(0), Buffer.from('{"v":"3"}').toString('base64url'), ''])(
    'cursor inválido %p é recusado',
    (cursor) => {
      expect(() => decodeLedgerCursor(cursor)).toThrow(RequestValidationError);
    },
  );
});

describe('parseMoney', () => {
  test('aponta o campo e o motivo', () => {
    try {
      parseMoney({ amount: '1.001', currency: 'BRL' }, 'initialBalance');
      throw new Error('deveria ter falhado');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      expect((error as RequestValidationError).issues).toEqual([
        { path: 'initialBalance', message: 'TOO_MANY_DECIMALS' },
      ]);
    }
  });
});

describe('ponto de extensão da autenticação', () => {
  test('sem IdP vale o payload; autenticado, só em nome de si mesmo; sem o guard, recusa', () => {
    expect(actsOnBehalfOf('anonymous', 'provider-a')).toBe(true);
    expect(actsOnBehalfOf(undefined, 'provider-a')).toBe(false);
    expect(actsOnBehalfOf({ providerId: 'provider-a' }, 'provider-a')).toBe(true);
    expect(actsOnBehalfOf({ providerId: 'provider-b' }, 'provider-a')).toBe(false);
  });
});
