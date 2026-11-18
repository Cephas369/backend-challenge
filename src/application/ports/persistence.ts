import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /** Trava a wallet até o fim da transação: tudo o que a toca fica serializado. */
  lockById(id: string): Promise<Wallet | undefined>;
  /**
   * Grava saldo e versão novos desde que a versão no banco ainda seja `expectedVersion`.
   * Lança ConcurrencyConflictError se outra transação mudou a wallet antes.
   */
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerPage {
  /** Versão a partir da qual continuar (exclusiva); ausente na primeira página. */
  readonly beforeVersion?: number | undefined;
  readonly limit: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Lançamentos em ordem decrescente de versão (mais recentes primeiro). */
  page(walletId: string, page: LedgerPage): Promise<WalletLedgerEntry[]>;
}

export interface WagerTransactionRepository {
  insert(transaction: WagerTransaction): Promise<void>;
  /** Grava as mudanças de estado; os campos de negócio são imutáveis. */
  save(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Existe REFUND ou ROLLBACK PROCESSED apontando para esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
}

export interface InboxRepository {
  /**
   * Registra a mensagem se `(consumerName, messageId)` ainda não existe e devolve `true`.
   * Devolve `false` para duplicata; se outra transação acabou de inserir a mesma, espera o desfecho dela.
   */
  tryInsert(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  save(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  append(messages: readonly OutboxMessage[]): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}

/** Repositórios ligados a uma mesma transação. */
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Executa `work` numa transação READ COMMITTED: tudo é confirmado junto ou nada é. */
  transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
  /** Leitura num snapshot consistente (REPEATABLE READ, somente leitura). */
  readOnly<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
