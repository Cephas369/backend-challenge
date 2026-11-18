import type { MoneyProps } from '../money/money';
import { DomainInvariantError } from '../shared/domain-error';
import type { FailureCode } from '../wagering/failure-code';
import type { WagerTransaction } from '../wagering/wager-transaction';
import type { WagerTransactionKind } from '../wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../wagering/wager-transaction-status';
import { type EventContext, IntegrationEvent } from './integration-event';

/** Identificação comum aos eventos de transação. */
export interface WagerTransactionEventBase {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  readonly referenceTransactionId: string | null;
  /** Saldo observado quando a transação foi aplicada. */
  readonly balance: MoneyProps;
  readonly processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  readonly failureCode: FailureCode;
  readonly balance: MoneyProps;
  readonly rejectedAt: string;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  readonly referenceExternalTransactionId: string;
  readonly nextCheckAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    const { processedAt, observedBalance } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      processedAt === undefined ||
      observedBalance === undefined
    ) {
      throw new DomainInvariantError('WagerTransactionProcessed exige transação PROCESSED');
    }
    return new WagerTransactionProcessed({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        balance: observedBalance.toJSON(),
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    const { failureCode, observedBalance } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined ||
      observedBalance === undefined
    ) {
      throw new DomainInvariantError('WagerTransactionRejected exige transação REJECTED');
    }
    return new WagerTransactionRejected({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        failureCode,
        balance: observedBalance.toJSON(),
        rejectedAt: transaction.updatedAt.toISOString(),
      },
    });
  }
}

/** A referência ainda não existe; a transação foi aceita e aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextReferenceCheckAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextReferenceCheckAt === undefined
    ) {
      throw new DomainInvariantError('WagerTransactionPendingReference exige transação PENDING_REFERENCE');
    }
    return new WagerTransactionPendingReference({
      ...context,
      aggregateId: transaction.id,
      data: {
        ...baseData(transaction),
        referenceExternalTransactionId,
        nextCheckAt: nextReferenceCheckAt.toISOString(),
      },
    });
  }
}

function baseData(transaction: WagerTransaction): WagerTransactionEventBase {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
