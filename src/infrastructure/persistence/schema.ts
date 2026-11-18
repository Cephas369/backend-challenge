import { defineEntity, type InferEntity, p } from '@mikro-orm/core';

/*
 * Modelos de persistência (um por tabela), separados do domínio. O DDL é das migrations;
 * aqui só ficam o mapeamento entre coluna e propriedade e as conversões. Dinheiro é sempre
 * `decimal('string')`: o valor chega exato do banco e vira `Money` no mapper.
 */

export const WalletSchema = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid(),
    currency: p.string(),
    balanceAmount: p.decimal('string'),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRecord = InferEntity<typeof WalletSchema>;

export const WagerTransactionSchema = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.string(),
    walletId: p.uuid(),
    playerId: p.uuid(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.text(),
    amount: p.decimal('string'),
    currency: p.string(),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.text(),
    failureCode: p.text().nullable(),
    observedBalanceAmount: p.decimal('string').nullable(),
    observedBalanceCurrency: p.string().nullable(),
    processedAt: p.datetime().nullable(),
    referenceAttempts: p.integer(),
    nextReferenceCheckAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WagerTransactionRecord = InferEntity<typeof WagerTransactionSchema>;

export const LedgerEntrySchema = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.text(),
    amount: p.decimal('string'),
    currency: p.string(),
    balanceBefore: p.decimal('string'),
    balanceAfter: p.decimal('string'),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRecord = InferEntity<typeof LedgerEntrySchema>;

export const InboxMessageSchema = defineEntity({
  name: 'InboxMessageRecord',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.string(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRecord = InferEntity<typeof InboxMessageSchema>;

export const OutboxMessageSchema = defineEntity({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.uuid(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
    lastError: p.text().nullable(),
  },
});
export type OutboxMessageRecord = InferEntity<typeof OutboxMessageSchema>;

export const PERSISTENCE_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
] as const;
