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

// erros dos use cases

export class WalletNotFoundError extends ApplicationError {
  override readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} não existe`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
    options?: ErrorOptions,
  ) {
    super(`o player ${playerId} já tem wallet em ${currency}`, options);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  override readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Mesma Idempotency-Key com payload diferente: conflito, não replay. */
export class IdempotencyConflictError extends ApplicationError {
  override readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(readonly existingTransactionId: string) {
    super('a Idempotency-Key já foi usada com outro payload');
  }
}

/** O mesmo (providerId, externalTransactionId) já existe sob outra Idempotency-Key. */
export class ExternalTransactionConflictError extends ApplicationError {
  override readonly code = 'EXTERNAL_ID_CONFLICT';

  constructor(readonly existingTransactionId: string) {
    super('o externalTransactionId já foi usado com outra Idempotency-Key');
  }
}

/** Mesmo messageId da fila com conteúdo diferente: bug no produtor, não dá para processar. */
export class InboxPayloadMismatchError extends ApplicationError {
  override readonly code = 'MESSAGE_ID_REUSED';

  constructor(readonly messageId: string) {
    super(`a mensagem ${messageId} já foi recebida com outro conteúdo`);
  }
}
