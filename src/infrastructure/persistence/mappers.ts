import { PersistenceInvariantError } from '../../application/errors';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import {
  type FailureCode,
  InfrastructureFailureCode,
  RejectionCode,
} from '../../domain/wagering/failure-code';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './schema';

/*
 * Conversão entre registro e domínio. A volta do banco usa sempre `rehydrate`, que reconstrói o estado sem
 * revalidar transições. Dinheiro volta por `Money.from`: um valor fora do formato quebra alto.
 */

const FAILURE_CODES: Record<string, FailureCode> = { ...RejectionCode, ...InfrastructureFailureCode };

function enumValue<T extends string>(values: Record<string, T>, raw: string, column: string): T {
  if ((Object.values(values) as string[]).includes(raw)) {
    return raw as T;
  }
  throw new PersistenceInvariantError(undefined, `valor desconhecido em ${column}: ${raw}`);
}

function money(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

export const walletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balanceAmount, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balanceAmount: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const ledgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: enumValue(LedgerDirection, record.direction, 'direction'),
      money: money(record.amount, record.currency),
      balanceBefore: money(record.balanceBefore, record.currency),
      balanceAfter: money(record.balanceAfter, record.currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};

/** Campos que mudam ao longo da máquina de estados (o resto é imutável e o banco garante). */
export function wagerTransactionStateColumns(transaction: WagerTransaction) {
  const observed = transaction.observedBalance;
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    observedBalanceAmount: observed?.toJSON().amount ?? null,
    observedBalanceCurrency: observed?.currency ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
    updatedAt: transaction.updatedAt,
  };
}

export const wagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const observedAmount = optional(record.observedBalanceAmount);
    const observedCurrency = optional(record.observedBalanceCurrency);
    const failureCode = optional(record.failureCode);
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: enumValue(WagerTransactionKind, record.kind, 'kind'),
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: optional(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: enumValue(WagerTransactionStatus, record.status, 'status'),
      referenceTransactionId: optional(record.referenceTransactionId),
      failureCode:
        failureCode === undefined ? undefined : enumValue(FAILURE_CODES, failureCode, 'failure_code'),
      processedAt: optional(record.processedAt),
      observedBalance:
        observedAmount === undefined || observedCurrency === undefined
          ? undefined
          : money(observedAmount, observedCurrency),
      referenceAttempts: record.referenceAttempts,
      nextReferenceCheckAt: optional(record.nextReferenceCheckAt),
      updatedAt: record.updatedAt,
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toJSON().amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      createdAt: transaction.createdAt,
      ...wagerTransactionStateColumns(transaction),
    };
  },
};

export const inboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: optional(record.processedAt),
    });
  },
};

export const outboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: optional(record.nextAttemptAt),
      publishedAt: optional(record.publishedAt),
      lastError: optional(record.lastError),
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
      lastError: message.lastError ?? null,
    };
  },
};
