/**
 * Rejeição por regra de negócio. A transação fica REJECTED, é terminal, e reenviar a mesma
 * operação devolve o mesmo resultado: o provedor deve corrigir a causa ou desistir.
 */
export enum RejectionCode {
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão (ROLLBACK de WIN ou REFUND) que deixaria o saldo negativo. Situação distinta de uma aposta sem saldo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** O playerId da operação não é o dono da wallet. */
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** A referência não apareceu dentro do TTL. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas não está PROCESSED (foi rejeitada, falhou ou não terminou dentro do TTL). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência é de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** O tipo da referência não é aceito (ex.: REFUND de um WIN). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** A referência já foi revertida por um REFUND ou ROLLBACK processado. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor do REFUND/ROLLBACK diferente do valor da referência (reversão parcial está fora de escopo). */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
}

/** Falha permanente de infraestrutura numa transação já persistida: FAILED, terminal e auditável. */
export enum InfrastructureFailureCode {
  /** O banco recusou o resultado por uma invariante (indica bug; nunca é caminho de negócio). */
  InvariantViolation = 'INVARIANT_VIOLATION',
  /** Erro não recuperável ao reprocessar a transação. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export type FailureCode = RejectionCode | InfrastructureFailureCode;
