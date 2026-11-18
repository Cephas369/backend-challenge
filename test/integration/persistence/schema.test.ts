import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { RejectionCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { buildOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import {
  createMigratedDatabase,
  createTestDatabase,
  type MigratedDatabase,
  testDatabaseConfig,
} from '../../support/database';
import {
  brl,
  databaseFailure,
  persistOpenedWallet,
  rawSql,
  rawTransaction,
  settleAndPersist,
  uuid,
  wagerFor,
} from '../../support/persistence';

let db: MigratedDatabase;

beforeAll(async () => {
  db = await createMigratedDatabase('schema');
});

afterAll(async () => {
  await db?.close();
});

/** Wallet aberta com 100.00 e uma BET de 25.00 processada: versão 2, saldo 75.00. */
async function walletAfterBet() {
  const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
  const { transaction: bet } = await settleAndPersist(db.unitOfWork, wallet.id, (w) =>
    wagerFor(w, Kind.Bet, { money: brl('25.00') }),
  );
  return { walletId: wallet.id, playerId: wallet.playerId, bet };
}

/** INSERT de uma transação direto no banco, com padrões válidos para um PENDING. */
function transactionInsert(values: Record<string, unknown>): [string, unknown[]] {
  const now = new Date();
  const row: Record<string, unknown> = {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: uuid(),
    idempotency_key: uuid(),
    payload_hash: 'a'.repeat(64),
    player_id: uuid(),
    round_id: 'round-1',
    game_id: 'fortune-chimp',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    status: 'PENDING',
    created_at: now,
    updated_at: now,
    ...values,
  };
  const columns = Object.keys(row);
  return [
    `insert into wager_transactions (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    Object.values(row),
  ];
}

function insertTransaction(values: Record<string, unknown>): Promise<unknown> {
  const [sql, params] = transactionInsert(values);
  return rawSql(db.orm, sql, params);
}

const insertEntrySql = `insert into wallet_ledger_entries
  (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`;

describe('migrations', () => {
  test('sobem, descem e sobem de novo a partir de um banco vazio', async () => {
    const database = await createTestDatabase('migrations');
    const orm = await MikroORM.init(
      buildOrmOptions(testDatabaseConfig(database.url), createLogger({ level: 'silent' })),
    );
    const tables = async () => {
      const rows = await orm.em
        .fork()
        .execute<{ name: string }[]>(
          "select tablename as name from pg_tables where schemaname = 'public' and tablename <> 'mikro_orm_migrations' order by 1",
        );
      return rows.map((row) => row.name);
    };
    try {
      expect((await orm.migrator.getPending()).map((migration) => migration.name)).toEqual([
        'Migration20261119000000_initial_schema',
      ]);
      await orm.migrator.up();
      expect(await tables()).toEqual([
        'inbox_messages',
        'outbox_messages',
        'wager_transactions',
        'wallet_ledger_entries',
        'wallets',
      ]);
      await orm.migrator.down();
      expect(await tables()).toEqual([]);
      await orm.migrator.up();
      expect(await tables()).toHaveLength(5);
    } finally {
      await orm.close();
      await database.drop();
    }
  });
});

describe('unicidade no schema', () => {
  test('uma wallet por player e moeda', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '0.00');
    const failure = await databaseFailure(() =>
      rawSql(db.orm, "insert into wallets values (?, ?, 'BRL', 0, 1, now(), now())", [
        uuid(),
        wallet.playerId,
      ]),
    );
    expect(failure).toMatchObject({ code: '23505', constraint: 'wallets_player_currency_uq' });
  });

  test('idempotency key e externalTransactionId únicos por provider', async () => {
    const { walletId, bet } = await walletAfterBet();

    expect(
      await databaseFailure(() =>
        insertTransaction({ wallet_id: walletId, idempotency_key: bet.idempotencyKey }),
      ),
    ).toMatchObject({ code: '23505', constraint: 'wager_tx_idempotency_uq' });
    expect(
      await databaseFailure(() =>
        insertTransaction({ wallet_id: walletId, external_transaction_id: bet.externalTransactionId }),
      ),
    ).toMatchObject({ code: '23505', constraint: 'wager_tx_external_uq' });
  });

  test('no máximo uma reversão PROCESSED por transação referenciada', async () => {
    const { walletId, bet } = await walletAfterBet();
    const processedReversal = (kind: 'REFUND' | 'ROLLBACK') =>
      transactionInsert({
        wallet_id: walletId,
        player_id: bet.playerId,
        kind,
        amount: '25.00',
        reference_external_transaction_id: bet.externalTransactionId,
        reference_transaction_id: bet.id,
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance_amount: '100.00',
        observed_balance_currency: 'BRL',
      });
    // as duas na mesma transação: o índice único barra a segunda na hora, antes do commit
    const failure = await databaseFailure(() =>
      rawTransaction(db.orm, [processedReversal('REFUND'), processedReversal('ROLLBACK')]),
    );
    expect(failure).toMatchObject({ code: '23505', constraint: 'wager_tx_single_reversal_uq' });
  });

  test('no máximo um lançamento por transação', async () => {
    const { walletId, bet } = await walletAfterBet();
    const failure = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [
        uuid(),
        walletId,
        bet.id,
        'DEBIT',
        '25.00',
        'BRL',
        '75.00',
        '50.00',
        3,
      ]),
    );
    expect(failure).toMatchObject({ code: '23505', constraint: 'ledger_one_entry_per_transaction_uq' });
  });
});

describe('não negatividade e aritmética no schema', () => {
  test('saldo da wallet não fica negativo', async () => {
    const { walletId } = await walletAfterBet();
    const failure = await databaseFailure(() =>
      rawSql(db.orm, "update wallets set balance_amount = '-0.01' where id = ?", [walletId]),
    );
    expect(failure).toMatchObject({ code: '23514', constraint: 'wallets_balance_non_negative_ck' });
  });

  test('lançamento cuja conta não fecha é recusado', async () => {
    const { walletId } = await walletAfterBet();
    const pending = uuid();
    await insertTransaction({ id: pending, wallet_id: walletId });
    const failure = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [
        uuid(),
        walletId,
        pending,
        'DEBIT',
        '10.00',
        'BRL',
        '75.00',
        '70.00',
        3,
      ]),
    );
    expect(failure).toMatchObject({ code: '23514', constraint: 'ledger_arithmetic_ck' });
  });

  test('lançamento não pode levar o saldo abaixo de zero', async () => {
    const { walletId } = await walletAfterBet();
    const pending = uuid();
    await insertTransaction({ id: pending, wallet_id: walletId, amount: '80.00' });
    const failure = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [
        uuid(),
        walletId,
        pending,
        'DEBIT',
        '80.00',
        'BRL',
        '75.00',
        '-5.00',
        3,
      ]),
    );
    expect(failure.code).toBe('23514');
  });

  test('moeda do lançamento tem de ser a da wallet (FK composta)', async () => {
    const { walletId } = await walletAfterBet();
    const usd = uuid();
    await insertTransaction({ id: usd, wallet_id: walletId, currency: 'USD' });
    const failure = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [uuid(), walletId, usd, 'CREDIT', '10.00', 'USD', '75.00', '85.00', 3]),
    );
    expect(failure).toMatchObject({ code: '23503', constraint: 'ledger_wallet_currency_fk' });
  });
});

describe('coerência das transações no schema', () => {
  test('OPENING só existe no provider interno', async () => {
    const { walletId } = await walletAfterBet();
    const failure = await databaseFailure(() => insertTransaction({ wallet_id: walletId, kind: 'OPENING' }));
    expect(failure).toMatchObject({ code: '23514', constraint: 'wager_tx_opening_is_internal_ck' });
  });

  test('REFUND exige referência e BET não aceita referência', async () => {
    const { walletId } = await walletAfterBet();
    expect(
      await databaseFailure(() => insertTransaction({ wallet_id: walletId, kind: 'REFUND' })),
    ).toMatchObject({
      code: '23514',
      constraint: 'wager_tx_reference_required_ck',
    });
    expect(
      await databaseFailure(() =>
        insertTransaction({ wallet_id: walletId, reference_external_transaction_id: 'x' }),
      ),
    ).toMatchObject({ code: '23514', constraint: 'wager_tx_reference_forbidden_ck' });
  });

  test('failureCode é obrigatório em REJECTED e precisa ser um código de rejeição', async () => {
    const { walletId } = await walletAfterBet();
    const rejected = {
      wallet_id: walletId,
      status: 'REJECTED',
      observed_balance_amount: '75.00',
      observed_balance_currency: 'BRL',
    };
    expect(await databaseFailure(() => insertTransaction(rejected))).toMatchObject({
      code: '23514',
      constraint: 'wager_tx_failure_code_ck',
    });
    expect(
      await databaseFailure(() => insertTransaction({ ...rejected, failure_code: 'INVARIANT_VIOLATION' })),
    ).toMatchObject({ code: '23514', constraint: 'wager_tx_failure_code_ck' });
    await insertTransaction({ ...rejected, failure_code: RejectionCode.InsufficientFunds });
  });
});

describe('imutabilidade no schema', () => {
  test('o ledger é append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { bet } = await walletAfterBet();

    for (const sql of [
      "update wallet_ledger_entries set amount = '1.00' where transaction_id = ?",
      'delete from wallet_ledger_entries where transaction_id = ?',
    ]) {
      expect((await databaseFailure(() => rawSql(db.orm, sql, [bet.id]))).code).toBe('WP001');
    }
    expect((await databaseFailure(() => rawSql(db.orm, 'truncate wallet_ledger_entries cascade'))).code).toBe(
      'WP001',
    );
  });

  test('transações não são apagadas', async () => {
    const { bet } = await walletAfterBet();
    expect(
      (await databaseFailure(() => rawSql(db.orm, 'delete from wager_transactions where id = ?', [bet.id])))
        .code,
    ).toBe('WP001');
  });

  test('estado terminal não muda e campos de negócio não mudam', async () => {
    const { walletId, bet } = await walletAfterBet();
    const pending = uuid();
    await insertTransaction({ id: pending, wallet_id: walletId });

    const terminal = await databaseFailure(() =>
      rawSql(
        db.orm,
        "update wager_transactions set status = 'FAILED', failure_code = 'PROCESSING_FAILED' where id = ?",
        [bet.id],
      ),
    );
    const business = await databaseFailure(() =>
      rawSql(db.orm, "update wager_transactions set amount = '99.00' where id = ?", [pending]),
    );
    const backwards = await databaseFailure(() =>
      rawSql(
        db.orm,
        "update wager_transactions set status = 'PENDING_REFERENCE', next_reference_check_at = now(), observed_balance_amount = '1.00', observed_balance_currency = 'BRL', reference_external_transaction_id = 'x' where id = ?",
        [pending],
      ),
    );

    expect(terminal.code).toBe('WP002');
    expect(business.code).toBe('WP002');
    expect(backwards.code).toBe('WP002');
  });
});

describe('consistência saldo ↔ ledger ↔ transação (checada no commit)', () => {
  test('lançamento fora da cadeia é recusado na hora', async () => {
    const { walletId } = await walletAfterBet();
    const pending = uuid();
    await insertTransaction({ id: pending, wallet_id: walletId });
    const wrongBefore = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [
        uuid(),
        walletId,
        pending,
        'DEBIT',
        '10.00',
        'BRL',
        '80.00',
        '70.00',
        3,
      ]),
    );
    const skippedVersion = await databaseFailure(() =>
      rawSql(db.orm, insertEntrySql, [
        uuid(),
        walletId,
        pending,
        'DEBIT',
        '10.00',
        'BRL',
        '75.00',
        '65.00',
        4,
      ]),
    );
    expect(wrongBefore.code).toBe('WP003');
    expect(skippedVersion.code).toBe('WP003');
  });

  test('saldo alterado sem lançamento não passa no commit', async () => {
    const { walletId } = await walletAfterBet();
    const failure = await databaseFailure(() =>
      rawTransaction(db.orm, [["update wallets set balance_amount = '1000.00' where id = ?", [walletId]]]),
    );
    expect(failure.code).toBe('WP004');
  });

  test('lançamento sem a wallet acompanhar não passa no commit', async () => {
    const { walletId, playerId } = await walletAfterBet();
    const bet = uuid();
    const failure = await databaseFailure(() =>
      rawTransaction(db.orm, [
        [
          `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, processed_at, observed_balance_amount, observed_balance_currency, created_at, updated_at)
           values (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'BET', '5.00', 'BRL', 'PROCESSED', now(), '70.00', 'BRL', now(), now())`,
          [bet, uuid(), uuid(), 'c'.repeat(64), walletId, playerId],
        ],
        [insertEntrySql, [uuid(), walletId, bet, 'DEBIT', '5.00', 'BRL', '75.00', '70.00', 3]],
      ]),
    );
    expect(failure.code).toBe('WP004');
  });

  test('transação PROCESSED que move saldo sem lançamento não passa no commit', async () => {
    const { walletId } = await walletAfterBet();
    const failure = await databaseFailure(() =>
      insertTransaction({
        wallet_id: walletId,
        status: 'PROCESSED',
        processed_at: new Date(),
        observed_balance_amount: '75.00',
        observed_balance_currency: 'BRL',
      }),
    );
    expect(failure.code).toBe('WP005');
  });

  test('lançamento de transação REJECTED não passa no commit', async () => {
    const { walletId, playerId } = await walletAfterBet();
    const rejected = uuid();
    const failure = await databaseFailure(() =>
      rawTransaction(db.orm, [
        [
          `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status, failure_code, observed_balance_amount, observed_balance_currency, created_at, updated_at)
           values (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'BET', '5.00', 'BRL', 'REJECTED', 'INSUFFICIENT_FUNDS', '75.00', 'BRL', now(), now())`,
          [rejected, uuid(), uuid(), 'd'.repeat(64), walletId, playerId],
        ],
        [insertEntrySql, [uuid(), walletId, rejected, 'DEBIT', '5.00', 'BRL', '75.00', '70.00', 3]],
        ["update wallets set balance_amount = '70.00', version = 3 where id = ?", [walletId]],
      ]),
    );
    expect(failure.code).toBe('WP005');
  });
});

describe('privilégio mínimo', () => {
  test('o role da aplicação insere e lê o ledger, mas não altera nem apaga', async () => {
    const [privileges] = await db.orm.em
      .fork()
      .execute<{ insert: boolean; select: boolean; update: boolean; delete: boolean }[]>(
        `select has_table_privilege('wagering_runtime', 'wallet_ledger_entries', 'INSERT') as insert,
              has_table_privilege('wagering_runtime', 'wallet_ledger_entries', 'SELECT') as select,
              has_table_privilege('wagering_runtime', 'wallet_ledger_entries', 'UPDATE') as update,
              has_table_privilege('wagering_runtime', 'wallet_ledger_entries', 'DELETE') as delete`,
      );
    expect(privileges).toEqual({ insert: true, select: true, update: false, delete: false });

    const failure = await databaseFailure(() =>
      rawTransaction(db.orm, [
        ['set local role wagering_runtime'],
        ["update wallet_ledger_entries set amount = '1.00' where false"],
      ]),
    );
    expect(failure.code).toBe('42501');
  });
});
