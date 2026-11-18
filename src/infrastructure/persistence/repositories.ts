import { LockMode, type QueryResult } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, PersistenceInvariantError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/persistence';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  inboxMessageMapper,
  ledgerEntryMapper,
  outboxMessageMapper,
  wagerTransactionMapper,
  wagerTransactionStateColumns,
  walletMapper,
} from './mappers';
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from './schema';

/*
 * Cada operação é um comando explícito (`insert`, `nativeUpdate`, `findOne` com lock) executado na
 * hora, dentro da transação do `UnitOfWork`. O flush implícito do Unit of Work não é usado: assim a
 * ordem das escritas é a do código e cada constraint violada aparece na operação que a causou.
 * O identity map também fica desligado nas leituras, para nunca devolver um registro já alterado
 * por um `nativeUpdate` da mesma transação.
 */
const FRESH = { disableIdentityMap: true } as const;

class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletMapper.toRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, FRESH);
    return record === null ? undefined : walletMapper.toDomain(record);
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record === null ? undefined : walletMapper.toDomain(record);
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balanceAmount: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (updated !== 1) {
      throw new ConcurrencyConflictError(`a wallet ${wallet.id} não está mais na versão ${expectedVersion}`);
    }
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, page: LedgerPage): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      page.beforeVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $lt: page.beforeVersion } },
      { ...FRESH, orderBy: { walletVersion: 'desc' }, limit: page.limit },
    );
    return records.map((record) => ledgerEntryMapper.toDomain(record));
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, wagerTransactionMapper.toRecord(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id },
      wagerTransactionStateColumns(transaction),
    );
    if (updated !== 1) {
      throw new PersistenceInvariantError(
        undefined,
        `transação ${transaction.id} não encontrada para atualizar`,
      );
    }
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ id });
  }

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  private async findOne(where: {
    id?: string;
    providerId?: string;
    idempotencyKey?: string;
    externalTransactionId?: string;
  }): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, FRESH);
    return record === null ? undefined : wagerTransactionMapper.toDomain(record);
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(message: InboxMessage): Promise<boolean> {
    // ON CONFLICT DO NOTHING: uma entrega concorrente da mesma mensagem espera esta transação
    // terminar e então não insere nada (sem erro, sem abortar a transação dela)
    const result = await this.em.execute<QueryResult>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxMessageSchema, { consumerName, messageId }, FRESH);
    return record === null ? undefined : inboxMessageMapper.toDomain(record);
  }

  async save(message: InboxMessage): Promise<void> {
    const updated = await this.em.nativeUpdate(
      InboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
    if (updated !== 1) {
      throw new PersistenceInvariantError(undefined, `mensagem ${message.messageId} não está na inbox`);
    }
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async append(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length > 0) {
      await this.em.insertMany(
        OutboxMessageSchema,
        messages.map((message) => outboxMessageMapper.toRecord(message)),
      );
    }
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageSchema, { id }, FRESH);
    return record === null ? undefined : outboxMessageMapper.toDomain(record);
  }
}

/** Repositórios que compartilham o mesmo EntityManager, logo a mesma transação. */
export function createRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
