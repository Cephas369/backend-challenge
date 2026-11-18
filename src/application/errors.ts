/** Erros que os adaptadores de infraestrutura lançam em termos que o use case entende. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type TransientReason = 'LOCK_TIMEOUT' | 'STATEMENT_TIMEOUT' | 'CONNECTION';

/** Falha passageira (banco fora, lock demorado): repetir a operação com a mesma key é seguro. */
export class TransientInfrastructureError extends ApplicationError {
  override readonly code = 'TRANSIENT_INFRASTRUCTURE';

  constructor(
    readonly reason: TransientReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * Outra transação mudou o mesmo dado (versão divergente, deadlock, serialização, reversão concorrente).
 * Nada foi gravado; repetir a unidade de trabalho resolve.
 */
export class ConcurrencyConflictError extends ApplicationError {
  override readonly code = 'CONCURRENCY_CONFLICT';
}

export type UniquenessSubject =
  | 'WALLET_PLAYER_CURRENCY'
  | 'TRANSACTION_IDEMPOTENCY_KEY'
  | 'TRANSACTION_EXTERNAL_ID';

/** Unicidade de negócio violada: wallet duplicada, ou key/externalTransactionId já usados. */
export class UniquenessViolationError extends ApplicationError {
  override readonly code = 'UNIQUENESS_VIOLATION';

  constructor(
    readonly subject: UniquenessSubject,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/**
 * O banco recusou o resultado por uma invariante (CHECK, FK, trigger). Indica bug: o domínio
 * deveria ter impedido antes. Não é transitório.
 */
export class PersistenceInvariantError extends ApplicationError {
  override readonly code = 'PERSISTENCE_INVARIANT_VIOLATION';

  constructor(
    readonly sqlState: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
