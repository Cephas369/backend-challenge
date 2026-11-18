import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  PersistenceInvariantError,
  TransientInfrastructureError,
  UniquenessViolationError,
} from '../../../src/application/errors';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { ReferenceRetryPolicy } from '../../../src/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../../src/domain/wagering/wager-settlement';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { buildOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createMigratedDatabase, type MigratedDatabase, testDatabaseConfig } from '../../support/database';
import { brl, persistOpenedWallet, settleAndPersist, uuid, wagerFor } from '../../support/persistence';
import { latch } from '../../support/wait';

let db: MigratedDatabase;

beforeAll(async () => {
  db = await createMigratedDatabase('repositories');
});

afterAll(async () => {
  await db?.close();
});

describe('ida e volta pelo banco', () => {
  test('wallet aberta, OPENING, crédito de abertura e evento na outbox', async () => {
    const { wallet, opening, openingEntry } = await persistOpenedWallet(db.unitOfWork, '1000.00');
    const event = WalletBalanceChanged.from(wallet, openingEntry as NonNullable<typeof openingEntry>, {
      eventId: uuid(),
      correlationId: 'corr-1',
      occurredAt: new Date(),
    });
    await db.unitOfWork.transaction(({ outbox }) => outbox.append([OutboxMessage.enqueue(event)]));

    const loaded = await db.unitOfWork.readOnly(async ({ wallets, transactions, ledger, outbox }) => ({
      wallet: await wallets.findById(wallet.id),
      opening: await transactions.findByIdempotencyKey('system', `system:opening:${wallet.id}`),
      entries: await ledger.page(wallet.id, { limit: 10 }),
      message: await outbox.findById(event.eventId),
    }));

    expect(loaded.wallet?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(loaded.wallet?.version).toBe(1);
    expect(loaded.opening?.id).toBe(opening?.id);
    expect(loaded.opening?.status).toBe(Status.Processed);
    expect(loaded.entries.map((entry) => [entry.direction, entry.walletVersion])).toEqual([
      [LedgerDirection.Credit, 1],
    ]);
    expect(loaded.message?.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(loaded.message?.isDue(new Date())).toBe(true);
  });

  test('BET processada: transação, lançamento e saldo gravados juntos, ledger do mais recente ao mais antigo', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const { transaction } = await settleAndPersist(db.unitOfWork, wallet.id, (w) =>
      wagerFor(w, Kind.Bet, { money: brl('25.00') }),
    );

    const loaded = await db.unitOfWork.readOnly(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(wallet.id),
      bet: await transactions.findByExternalId('provider-a', transaction.externalTransactionId),
      entries: await ledger.page(wallet.id, { limit: 10 }),
      olderPage: await ledger.page(wallet.id, { beforeVersion: 2, limit: 10 }),
    }));

    expect(loaded.wallet?.balance.toJSON().amount).toBe('75.00');
    expect(loaded.wallet?.version).toBe(2);
    expect(loaded.bet?.status).toBe(Status.Processed);
    expect(loaded.bet?.observedBalance?.toJSON().amount).toBe('75.00');
    expect(loaded.bet?.matchesPayload(transaction.payloadHash)).toBe(true);
    expect(loaded.entries.map((entry) => entry.walletVersion)).toEqual([2, 1]);
    expect(loaded.olderPage.map((entry) => entry.walletVersion)).toEqual([1]);
  });

  test('PENDING_REFERENCE gravada e depois processada quando a referência chega', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const betExternalId = uuid();
    const { transaction: refund } = await settleAndPersist(
      db.unitOfWork,
      wallet.id,
      (w) => wagerFor(w, Kind.Refund, { referenceExternalTransactionId: betExternalId }),
      { type: 'NOT_FOUND' },
    );
    expect(refund.status).toBe(Status.PendingReference);
    const { transaction: bet } = await settleAndPersist(db.unitOfWork, wallet.id, (w) =>
      wagerFor(w, Kind.Bet, { externalTransactionId: betExternalId }),
    );

    await db.unitOfWork.transaction(async ({ wallets, transactions, ledger }) => {
      const locked = await wallets.lockById(wallet.id);
      const pending = await transactions.findById(refund.id);
      if (locked === undefined || pending === undefined) {
        throw new Error('dados de teste ausentes');
      }
      const expectedVersion = locked.version;
      const outcome = new WagerSettlement(new ReferenceRetryPolicy()).settle({
        transaction: pending,
        wallet: locked,
        reference: {
          type: 'FOUND',
          transaction: bet,
          alreadyReversed: await transactions.hasProcessedReversal(bet.id),
        },
        entryId: uuid(),
        now: new Date(),
      });
      if (outcome.type !== 'PROCESSED' || outcome.entry === undefined) {
        throw new Error(`desfecho inesperado: ${outcome.type}`);
      }
      await transactions.save(pending);
      await ledger.append(outcome.entry);
      await wallets.saveBalance(locked, expectedVersion);
    });

    const reloaded = await db.unitOfWork.readOnly(async ({ transactions, wallets }) => ({
      refund: await transactions.findById(refund.id),
      wallet: await wallets.findById(wallet.id),
      reversed: await transactions.hasProcessedReversal(bet.id),
    }));
    expect(reloaded.refund?.status).toBe(Status.Processed);
    expect(reloaded.refund?.referenceTransactionId).toBe(bet.id);
    expect(reloaded.refund?.nextReferenceCheckAt).toBeUndefined();
    expect(reloaded.wallet?.balance.toJSON().amount).toBe('100.00');
    expect(reloaded.reversed).toBe(true);
  });

  test('valores grandes atravessam o banco sem perder precisão', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '99999999999999999.99');
    await settleAndPersist(db.unitOfWork, wallet.id, (w) => wagerFor(w, Kind.Bet, { money: brl('0.01') }));

    const loaded = await db.unitOfWork.readOnly(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded?.balance.toJSON().amount).toBe('99999999999999999.98');
  });
});

describe('atomicidade e tradução de erros', () => {
  test('erro dentro da unidade de trabalho desfaz tudo', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const bet = wagerFor(wallet, Kind.Bet);

    const attempt = db.unitOfWork.transaction(async ({ transactions }) => {
      await transactions.insert(bet);
      throw new Error('falha no meio do caminho');
    });

    await expect(attempt).rejects.toThrow('falha no meio do caminho');
    expect(await db.unitOfWork.readOnly(({ transactions }) => transactions.findById(bet.id))).toBeUndefined();
  });

  test('unicidade de negócio vira UniquenessViolationError com o assunto', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const { transaction: bet } = await settleAndPersist(db.unitOfWork, wallet.id, (w) =>
      wagerFor(w, Kind.Bet),
    );
    const subjectOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return error instanceof UniquenessViolationError ? error.subject : error;
      }
      return 'sem erro';
    };

    const duplicateKey = wagerFor(wallet, Kind.Bet, { idempotencyKey: bet.idempotencyKey });
    const duplicateExternal = wagerFor(wallet, Kind.Bet, {
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: uuid(),
    });
    const duplicateWallet = Wallet.open({
      id: uuid(),
      playerId: wallet.playerId,
      initialBalance: brl('0.00'),
      openedAt: new Date(),
      openingTransactionId: uuid(),
      openingEntryId: uuid(),
    }).wallet;

    expect(
      await subjectOf(() =>
        db.unitOfWork.transaction(({ transactions }) => transactions.insert(duplicateKey)),
      ),
    ).toBe('TRANSACTION_IDEMPOTENCY_KEY');
    expect(
      await subjectOf(() =>
        db.unitOfWork.transaction(({ transactions }) => transactions.insert(duplicateExternal)),
      ),
    ).toBe('TRANSACTION_EXTERNAL_ID');
    expect(
      await subjectOf(() => db.unitOfWork.transaction(({ wallets }) => wallets.insert(duplicateWallet))),
    ).toBe('WALLET_PLAYER_CURRENCY');
  });

  test('saveBalance com versão desatualizada vira ConcurrencyConflictError e não grava nada', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const staleVersion = wallet.version;
    await settleAndPersist(db.unitOfWork, wallet.id, (w) => wagerFor(w, Kind.Bet, { money: brl('10.00') }));

    const attempt = db.unitOfWork.transaction(async ({ wallets }) => {
      const current = await wallets.findById(wallet.id);
      if (current === undefined) {
        throw new Error('wallet ausente');
      }
      current.credit({ entryId: uuid(), transactionId: uuid(), money: brl('1.00'), at: new Date() });
      await wallets.saveBalance(current, staleVersion);
    });

    await expect(attempt).rejects.toBeInstanceOf(ConcurrencyConflictError);
    expect(
      (await db.unitOfWork.readOnly(({ wallets }) => wallets.findById(wallet.id)))?.balance.toJSON().amount,
    ).toBe('90.00');
  });

  test('saldo gravado sem lançamento é barrado no commit e vira PersistenceInvariantError (WP004)', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');

    const attempt = db.unitOfWork.transaction(async ({ wallets }) => {
      const locked = await wallets.lockById(wallet.id);
      if (locked === undefined) {
        throw new Error('wallet ausente');
      }
      const expectedVersion = locked.version;
      // o domínio cria o lançamento, mas o bug "esquece" de gravá-lo
      locked.credit({ entryId: uuid(), transactionId: uuid(), money: brl('50.00'), at: new Date() });
      await wallets.saveBalance(locked, expectedVersion);
    });

    const error = await attempt.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PersistenceInvariantError);
    expect((error as PersistenceInvariantError).sqlState).toBe('WP004');
  });

  test('escrita numa unidade somente leitura é recusada', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '0.00');
    const attempt = db.unitOfWork.readOnly(({ transactions }) =>
      transactions.insert(wagerFor(wallet, Kind.Win)),
    );
    const error = await attempt.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PersistenceInvariantError);
    expect((error as PersistenceInvariantError).sqlState).toBe('25006');
  });

  test('banco inalcançável vira TransientInfrastructureError de conexão', async () => {
    const unreachable = new URL(db.database.url);
    unreachable.port = '9';
    const orm = await MikroORM.init(
      buildOrmOptions(
        testDatabaseConfig(unreachable.toString(), { connectTimeoutMs: 500 }),
        createLogger({ level: 'silent' }),
      ),
    );
    try {
      const unitOfWork = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 1000, statementTimeoutMs: 1000 });
      const error = await unitOfWork
        .readOnly(({ wallets }) => wallets.findById(uuid()))
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).reason).toBe('CONNECTION');
    } finally {
      await orm.close();
    }
  });
});

describe('lock da wallet', () => {
  test('quem espera o lock enxerga o commit de quem o segurava (READ COMMITTED + FOR UPDATE)', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const holderLocked = latch();
    const holderMayCommit = latch();

    const holder = db.unitOfWork.transaction(async ({ wallets, transactions, ledger }) => {
      const locked = await wallets.lockById(wallet.id);
      if (locked === undefined) {
        throw new Error('wallet ausente');
      }
      holderLocked.release();
      await holderMayCommit.promise;
      const bet = wagerFor(locked, Kind.Bet, { money: brl('30.00') });
      const expectedVersion = locked.version;
      const entry = locked.debit({
        entryId: uuid(),
        transactionId: bet.id,
        money: bet.money,
        at: new Date(),
      });
      bet.markProcessed({
        referenceTransactionId: undefined,
        at: new Date(),
        observedBalance: locked.balance,
      });
      await transactions.insert(bet);
      await ledger.append(entry);
      await wallets.saveBalance(locked, expectedVersion);
    });
    await holderLocked.promise;

    const waiter = db.unitOfWork.transaction(({ wallets }) => wallets.lockById(wallet.id));
    holderMayCommit.release();
    await holder;
    const seenByWaiter = await waiter;

    expect(seenByWaiter?.version).toBe(2);
    expect(seenByWaiter?.balance.toJSON().amount).toBe('70.00');
  });

  test('espera além do lock_timeout vira TransientInfrastructureError LOCK_TIMEOUT', async () => {
    const { wallet } = await persistOpenedWallet(db.unitOfWork, '100.00');
    const impatient = db.unitOfWorkWith({ lockTimeoutMs: 150 });
    const holderLocked = latch();
    const holderMayFinish = latch();

    const holder = db.unitOfWork.transaction(async ({ wallets }) => {
      await wallets.lockById(wallet.id);
      holderLocked.release();
      await holderMayFinish.promise;
    });
    await holderLocked.promise;

    const error = await impatient
      .transaction(({ wallets }) => wallets.lockById(wallet.id))
      .catch((failure: unknown) => failure);
    holderMayFinish.release();
    await holder;

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).reason).toBe('LOCK_TIMEOUT');
  });
});

describe('inbox', () => {
  const received = (messageId: string) =>
    InboxMessage.receive({
      messageId,
      consumerName: 'wagering-processor',
      payloadHash: 'e'.repeat(64),
      receivedAt: new Date(),
    });

  test('registra uma vez; a mesma mensagem de novo é duplicata', async () => {
    const messageId = uuid();
    expect(await db.unitOfWork.transaction(({ inbox }) => inbox.tryInsert(received(messageId)))).toBe(true);
    expect(await db.unitOfWork.transaction(({ inbox }) => inbox.tryInsert(received(messageId)))).toBe(false);

    await db.unitOfWork.transaction(async ({ inbox }) => {
      const message = await inbox.find('wagering-processor', messageId);
      message?.markProcessed(new Date());
      if (message !== undefined) {
        await inbox.save(message);
      }
    });
    const stored = await db.unitOfWork.readOnly(({ inbox }) => inbox.find('wagering-processor', messageId));
    expect(stored?.isProcessed()).toBe(true);
  });

  test('entrega concorrente espera a primeira: duplicata se ela confirma, nova se ela desiste', async () => {
    for (const firstOutcome of ['commit', 'rollback'] as const) {
      const messageId = uuid();
      const firstInserted = latch();
      const firstMayFinish = latch();

      const first = db.unitOfWork
        .transaction(async ({ inbox }) => {
          await inbox.tryInsert(received(messageId));
          firstInserted.release();
          await firstMayFinish.promise;
          if (firstOutcome === 'rollback') {
            throw new Error('processamento falhou');
          }
        })
        .catch(() => undefined);
      await firstInserted.promise;

      const second = db.unitOfWork.transaction(({ inbox }) => inbox.tryInsert(received(messageId)));
      firstMayFinish.release();
      await first;

      expect(await second).toBe(firstOutcome === 'rollback');
    }
  });
});
