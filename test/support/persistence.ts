import type { MikroORM } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../../src/application/ports/persistence';
import { Money } from '../../src/domain/money/money';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import {
  type ReferenceResolution,
  type SettlementOutcome,
  WagerSettlement,
} from '../../src/domain/wagering/wager-settlement';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

/** As colunas de id são `uuid`: as fixtures de persistência usam UUIDv7 de verdade. */
export const uuid = (): string => Bun.randomUUIDv7();

export const brl = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

export interface PersistedWallet {
  readonly wallet: Wallet;
  readonly opening: WagerTransaction | undefined;
  readonly openingEntry: WalletLedgerEntry | undefined;
}

/** Abre e grava uma wallet como a aplicação fará: wallet, OPENING e crédito de abertura juntos. */
export async function persistOpenedWallet(
  unitOfWork: UnitOfWork,
  initialBalance = '100.00',
  currency = 'BRL',
): Promise<PersistedWallet> {
  const walletId = uuid();
  const playerId = uuid();
  const openingTransactionId = uuid();
  const openedAt = new Date();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(initialBalance, currency),
    openedAt,
    openingTransactionId,
    openingEntryId: uuid(),
  });
  const opening =
    openingEntry === undefined
      ? undefined
      : WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId,
          money: wallet.balance,
          at: openedAt,
        });
  await unitOfWork.transaction(async ({ wallets, transactions, ledger }) => {
    await wallets.insert(wallet);
    if (opening !== undefined && openingEntry !== undefined) {
      await transactions.insert(opening);
      await ledger.append(openingEntry);
    }
  });
  return { wallet, opening, openingEntry };
}

export function wagerFor(
  wallet: Wallet,
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? uuid();
  return WagerTransaction.create({
    id: uuid(),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('25.00'),
    createdAt: new Date(),
    ...overrides,
    providerId,
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
  });
}

const settlement = new WagerSettlement(
  new ReferenceRetryPolicy({ initialDelayMs: 1_000, maxDelayMs: 60_000, ttlMs: 15 * 60_000 }),
);

/**
 * Esqueleto do fluxo de liquidação: trava a wallet, aplica a regra
 * e grava transação, lançamento e saldo na mesma transação.
 */
export async function settleAndPersist(
  unitOfWork: UnitOfWork,
  walletId: string,
  build: (wallet: Wallet) => WagerTransaction,
  reference: ReferenceResolution = { type: 'NONE' },
): Promise<{ transaction: WagerTransaction; outcome: SettlementOutcome; wallet: Wallet }> {
  return unitOfWork.transaction(async ({ wallets, transactions, ledger }) => {
    const wallet = await wallets.lockById(walletId);
    if (wallet === undefined) {
      throw new Error(`wallet ${walletId} não existe`);
    }
    const expectedVersion = wallet.version;
    const transaction = build(wallet);
    const outcome = settlement.settle({ transaction, wallet, reference, entryId: uuid(), now: new Date() });
    await transactions.insert(transaction);
    if (outcome.type === 'PROCESSED' && outcome.entry !== undefined) {
      await ledger.append(outcome.entry);
      await wallets.saveBalance(wallet, expectedVersion);
    }
    return { transaction, outcome, wallet };
  });
}

export interface DatabaseFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly message: string;
}

/** Executa e devolve o erro do banco (SQLSTATE e constraint), ou falha o teste se não houver erro. */
export async function databaseFailure(run: () => Promise<unknown>): Promise<DatabaseFailure> {
  try {
    await run();
  } catch (error) {
    const details = error as { code?: unknown; constraint?: unknown; message?: unknown };
    return {
      code: typeof details.code === 'string' ? details.code : undefined,
      constraint: typeof details.constraint === 'string' ? details.constraint : undefined,
      message: String(details.message),
    };
  }
  throw new Error('era esperado que o banco recusasse a operação');
}

/** SQL cru na conexão do dono do banco (sem a aplicação no meio), para provocar violações. */
export function rawSql(orm: MikroORM, sql: string, params: unknown[] = []): Promise<unknown> {
  return orm.em.fork().execute(sql, params);
}

/** Várias instruções na mesma transação: as constraints adiadas só disparam no commit. */
export function rawTransaction(orm: MikroORM, statements: readonly [string, unknown[]?][]): Promise<void> {
  return orm.em.fork().transactional(async (em) => {
    for (const [sql, params] of statements) {
      await em.execute(sql, params ?? []);
    }
  });
}
