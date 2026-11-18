import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/errors';
import { InvalidMoneyError } from '../../domain/money/money';
import {
  InvalidWagerTransactionError,
  type InvalidWagerTransactionReason,
} from '../../domain/wagering/wager-transaction';
import { currentLogContext } from '../../infrastructure/observability/log-context';
import type { AppLogger } from '../../infrastructure/observability/logger';
import { RequestValidationError, type ValidationIssue } from './request-validation';

/** Problem Details (RFC 9457) com `code` estável e `retryable` explícito. */
export interface Problem {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  /** Reenviar o mesmo pedido, com a mesma Idempotency-Key, pode dar certo? */
  readonly retryable: boolean;
  readonly errors?: readonly ValidationIssue[];
}

const CONTRACT_CODES: Readonly<Record<InvalidWagerTransactionReason, string>> = {
  KIND_NOT_ALLOWED: 'KIND_NOT_ALLOWED',
  RESERVED_PROVIDER: 'RESERVED_PROVIDER',
  MISSING_FIELD: 'VALIDATION_FAILED',
  REFERENCE_REQUIRED: 'REFERENCE_REQUIRED',
  REFERENCE_NOT_ALLOWED: 'REFERENCE_NOT_ALLOWED',
  SELF_REFERENCE: 'SELF_REFERENCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
};

const TRANSIENT_CODES: Readonly<Record<TransientInfrastructureError['reason'], string>> = {
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  STATEMENT_TIMEOUT: 'DATABASE_TIMEOUT',
  CONNECTION: 'DATABASE_UNAVAILABLE',
};

const invalid = (code: string, detail: string, errors?: readonly ValidationIssue[]): Problem => ({
  status: 400,
  code,
  title: 'Pedido inválido',
  detail,
  retryable: false,
  ...(errors === undefined ? {} : { errors }),
});

/**
 * Único mapeamento de erro para HTTP, usado por todos os endpoints: payload inválido (400),
 * inexistente (404), conflito (409), falha transitória (503) e erro interno (500) nunca se confundem.
 * Rejeição de negócio (422) e aceite pendente (202) não passam por aqui: são resultados de transação.
 */
export function problemFor(error: unknown): Problem {
  if (error instanceof RequestValidationError) {
    return invalid(error.code, error.message, error.issues);
  }
  if (error instanceof InvalidMoneyError) {
    return invalid('INVALID_MONEY', error.message, [{ path: 'money', message: error.reason }]);
  }
  if (error instanceof InvalidWagerTransactionError) {
    return invalid(CONTRACT_CODES[error.reason], error.message);
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) {
    return {
      status: 404,
      code: error.code,
      title: 'Não encontrado',
      detail: error.message,
      retryable: false,
    };
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof WalletAlreadyExistsError
  ) {
    return { status: 409, code: error.code, title: 'Conflito', detail: error.message, retryable: false };
  }
  if (error instanceof TransientInfrastructureError) {
    return {
      status: 503,
      code: TRANSIENT_CODES[error.reason],
      title: 'Indisponível no momento',
      detail: 'falha transitória; reenvie com a mesma Idempotency-Key',
      retryable: true,
    };
  }
  if (error instanceof ConcurrencyConflictError) {
    return {
      status: 503,
      code: 'CONCURRENCY_CONFLICT',
      title: 'Indisponível no momento',
      detail: 'conflito de concorrência; reenvie com a mesma Idempotency-Key',
      retryable: true,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 404) {
      return {
        status,
        code: 'ROUTE_NOT_FOUND',
        title: 'Não encontrado',
        detail: 'rota inexistente',
        retryable: false,
      };
    }
    if (status === 413) {
      return {
        status,
        code: 'PAYLOAD_TOO_LARGE',
        title: 'Pedido grande demais',
        detail: error.message,
        retryable: false,
      };
    }
    if (status >= 400 && status < 500) {
      return { ...invalid('MALFORMED_REQUEST', 'corpo da requisição malformado'), status };
    }
  }
  return {
    status: 500,
    code: 'INTERNAL_ERROR',
    title: 'Erro interno',
    detail: 'erro inesperado',
    retryable: false,
  };
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const problem = problemFor(exception);
    if (problem.status >= 500 && problem.code === 'INTERNAL_ERROR') {
      this.logger.error({ err: exception }, 'request failed');
    } else {
      this.logger.info({ code: problem.code, status: problem.status }, 'request refused');
    }
    if (problem.retryable) {
      response.setHeader('Retry-After', '1');
    }
    response
      .status(problem.status)
      .type('application/problem+json')
      .json({
        type: `urn:problem:${problem.code.toLowerCase().replaceAll('_', '-')}`,
        ...problem,
        correlationId: currentLogContext()?.correlationId,
      });
  }
}
