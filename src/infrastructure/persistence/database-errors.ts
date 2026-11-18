import { ConnectionException } from '@mikro-orm/core';
import {
  ApplicationError,
  ConcurrencyConflictError,
  PersistenceInvariantError,
  TransientInfrastructureError,
  type UniquenessSubject,
  UniquenessViolationError,
} from '../../application/errors';
import { DomainError } from '../../domain/shared/domain-error';

/** Constraints únicas que representam regra de negócio. */
const UNIQUENESS_BY_CONSTRAINT: Readonly<Record<string, UniquenessSubject>> = {
  wallets_player_currency_uq: 'WALLET_PLAYER_CURRENCY',
  wager_tx_idempotency_uq: 'TRANSACTION_IDEMPOTENCY_KEY',
  wager_tx_external_uq: 'TRANSACTION_EXTERNAL_ID',
};

/** Unicidades que só quebram quando duas transações correm sobre o mesmo dado: repetir resolve. */
const CONCURRENCY_CONSTRAINTS: ReadonlySet<string> = new Set([
  'wager_tx_single_reversal_uq',
  'ledger_wallet_version_uq',
]);

/** SQLSTATEs de conexão perdida ou servidor indisponível. */
const UNAVAILABLE_STATES: ReadonlySet<string> = new Set(['57P01', '57P02', '57P03', '53300']);

/** Códigos de erro de rede do Node para conexão que não se estabelece ou cai. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const CONNECTION_FAILURE_MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|connection error|terminating connection|connect ECONNREFUSED/i;

/**
 * Traduz erros do driver para erros que a aplicação entende. Erros de domínio e de aplicação
 * passam intactos; o resto sem tradução também (é bug e deve aparecer como tal).
 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof DomainError || error instanceof ApplicationError) {
    return error;
  }
  const state = sqlStateOf(error);
  const options = { cause: error };

  if (state === '23505') {
    const constraint = constraintOf(error);
    const subject = constraint === undefined ? undefined : UNIQUENESS_BY_CONSTRAINT[constraint];
    if (subject !== undefined) {
      return new UniquenessViolationError(subject, `unicidade violada: ${constraint}`, options);
    }
    if (constraint !== undefined && CONCURRENCY_CONSTRAINTS.has(constraint)) {
      return new ConcurrencyConflictError(`escrita concorrente detectada por ${constraint}`, options);
    }
    return new PersistenceInvariantError(
      state,
      `unicidade inesperada violada: ${constraint ?? 'desconhecida'}`,
      options,
    );
  }
  if (state === '40001' || state === '40P01') {
    return new ConcurrencyConflictError(`conflito de concorrência no banco (${state})`, options);
  }
  if (state === '55P03') {
    return new TransientInfrastructureError('LOCK_TIMEOUT', 'tempo de espera pelo lock esgotado', options);
  }
  if (state === '57014') {
    return new TransientInfrastructureError('STATEMENT_TIMEOUT', 'comando cancelado por tempo', options);
  }
  if (state !== undefined && (state.startsWith('08') || UNAVAILABLE_STATES.has(state))) {
    return new TransientInfrastructureError('CONNECTION', `banco indisponível (${state})`, options);
  }
  if (
    state !== undefined &&
    (state.startsWith('WP') ||
      state.startsWith('23') ||
      state === 'P0001' ||
      state === '42501' ||
      state === '25006')
  ) {
    return new PersistenceInvariantError(state, `o banco recusou a operação (${state})`, options);
  }
  if (isConnectionFailure(error)) {
    return new TransientInfrastructureError('CONNECTION', 'falha de conexão com o banco', options);
  }
  return error;
}

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && !NETWORK_ERROR_CODES.has(code)
    ? code
    : undefined;
}

function constraintOf(error: unknown): string | undefined {
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  if (typeof constraint === 'string') {
    return constraint;
  }
  const message = error instanceof Error ? error.message : '';
  return /constraint "([^"]+)"/.exec(message)?.[1];
}

function isConnectionFailure(error: unknown, depth = 0): boolean {
  if (error instanceof ConnectionException) {
    return true;
  }
  if (!(error instanceof Error) || depth > 3) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return true;
  }
  if (CONNECTION_FAILURE_MESSAGE.test(error.message)) {
    return true;
  }
  if (
    error instanceof AggregateError &&
    error.errors.some((inner) => isConnectionFailure(inner, depth + 1))
  ) {
    return true;
  }
  return isConnectionFailure(error.cause, depth + 1);
}
