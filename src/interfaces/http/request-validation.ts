import type { z } from 'zod';
import { InvalidMoneyError, Money, type MoneyProps } from '../../domain/money/money';

export type RequestErrorCode =
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_MONEY'
  | 'INVALID_CURSOR';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Pedido malformado: nunca vira transação; responde 400 com o que está errado. */
export class RequestValidationError extends Error {
  constructor(
    readonly code: RequestErrorCode,
    message: string,
    readonly issues: readonly ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export function parseRequest<T>(schema: z.ZodType<T>, input: unknown, subject: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(
      'VALIDATION_FAILED',
      `${subject} inválido`,
      result.error.issues.map((issue) => ({ path: issue.path.join('.') || subject, message: issue.message })),
    );
  }
  return result.data;
}

/** Converte o dinheiro do contrato, apontando o campo e o motivo quando é inválido. */
export function parseMoney(props: MoneyProps, path: string): Money {
  try {
    return Money.from(props);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new RequestValidationError('INVALID_MONEY', error.message, [{ path, message: error.reason }]);
    }
    throw error;
  }
}

/** Cursor opaco e estável do ledger: a versão a partir da qual continuar. */
export function encodeLedgerCursor(beforeVersion: number): string {
  return Buffer.from(JSON.stringify({ v: beforeVersion }), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): number {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const version = (decoded as { v?: unknown } | null)?.v;
    if (typeof version === 'number' && Number.isInteger(version) && version >= 1) {
      return version;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new RequestValidationError('INVALID_CURSOR', 'cursor inválido', [
    { path: 'cursor', message: 'cursor inválido' },
  ]);
}
