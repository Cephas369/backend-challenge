import { describe, expect, test } from 'bun:test';
import { DomainInvariantError } from '../../../src/domain/shared/domain-error';
import { InfrastructureFailureCode, RejectionCode } from '../../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  type InvalidWagerTransactionReason,
  SYSTEM_PROVIDER_ID,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { minutesAfter, money, newWager, openWallet, T0 } from '../../support/domain';

const { wallet } = openWallet('100.00');

function reasonFor(create: () => unknown): InvalidWagerTransactionReason | undefined {
  try {
    create();
    return undefined;
  } catch (error) {
    if (error instanceof InvalidWagerTransactionError) {
      return error.reason;
    }
    throw error;
  }
}

const decision = { at: minutesAfter(T0, 1), observedBalance: money('100.00') };

describe('WagerTransaction: criação', () => {
  test('nasce PENDING, com payloadHash calculado a partir dos campos de negócio', () => {
    const bet = newWager(Kind.Bet, wallet, { money: money('25.00') });

    expect(bet.status).toBe(Status.Pending);
    expect(bet.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bet.payloadHash).toBe(WagerTransaction.payloadHashOf(bet));
    expect(bet.isTerminal()).toBe(false);
  });

  test.each<[string, () => unknown, InvalidWagerTransactionReason]>([
    ['OPENING pela API ou fila', () => newWager(Kind.Opening, wallet), 'KIND_NOT_ALLOWED'],
    [
      'provider reservado',
      () => newWager(Kind.Bet, wallet, { providerId: SYSTEM_PROVIDER_ID }),
      'RESERVED_PROVIDER',
    ],
    ['REFUND sem referência', () => newWager(Kind.Refund, wallet), 'REFERENCE_REQUIRED'],
    ['ROLLBACK sem referência', () => newWager(Kind.Rollback, wallet), 'REFERENCE_REQUIRED'],
    [
      'BET com referência',
      () => newWager(Kind.Bet, wallet, { referenceExternalTransactionId: 'ext-x' }),
      'REFERENCE_NOT_ALLOWED',
    ],
    [
      'referência a si mesma',
      () =>
        newWager(Kind.Refund, wallet, {
          externalTransactionId: 'ext-same',
          referenceExternalTransactionId: 'ext-same',
        }),
      'SELF_REFERENCE',
    ],
    [
      'referência vazia',
      () => newWager(Kind.Win, wallet, { referenceExternalTransactionId: ' ' }),
      'MISSING_FIELD',
    ],
    ['roundId vazio', () => newWager(Kind.Bet, wallet, { roundId: '' }), 'MISSING_FIELD'],
    ['BET de valor zero', () => newWager(Kind.Bet, wallet, { money: money('0.00') }), 'INVALID_AMOUNT'],
    ['WIN de valor zero', () => newWager(Kind.Win, wallet, { money: money('0.00') }), 'INVALID_AMOUNT'],
  ])('rejeita %s', (_case, create, reason) => {
    expect(reasonFor(create)).toBe(reason);
  });

  test('LOSS aceita valor zero', () => {
    expect(newWager(Kind.Loss, wallet, { money: money('0.00') }).status).toBe(Status.Pending);
  });

  test('OPENING interno nasce PROCESSED, no provider reservado', () => {
    const opening = WagerTransaction.opening({
      id: 'opening-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: money('1000.00'),
      at: T0,
    });

    expect(opening.status).toBe(Status.Processed);
    expect(opening.providerId).toBe(SYSTEM_PROVIDER_ID);
    expect(opening.idempotencyKey).toBe(`system:opening:${wallet.id}`);
    expect(opening.observedBalance?.toJSON().amount).toBe('1000.00');
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction: idempotency key com payload divergente', () => {
  test('mesmo payload combina; qualquer campo de negócio diferente não combina', () => {
    const bet = newWager(Kind.Bet, wallet, { money: money('25.00') });
    const sameRequest = WagerTransaction.payloadHashOf({ ...bet, money: money('25.00') });
    const differentAmount = WagerTransaction.payloadHashOf({ ...bet, money: money('26.00') });
    const differentRound = WagerTransaction.payloadHashOf({ ...bet, roundId: 'round-2' });

    expect(bet.matchesPayload(sameRequest)).toBe(true);
    expect(bet.matchesPayload(differentAmount)).toBe(false);
    expect(bet.matchesPayload(differentRound)).toBe(false);
  });
});

describe('WagerTransaction: máquina de estados', () => {
  const reference = () => newWager(Kind.Refund, wallet, { referenceExternalTransactionId: 'ext-bet' });

  test('PENDING → PROCESSED guarda referência, momento e saldo observado', () => {
    const refund = reference();
    refund.markProcessed({ ...decision, referenceTransactionId: 'tx-bet' });

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe('tx-bet');
    expect(refund.processedAt).toEqual(decision.at);
    expect(refund.observedBalance?.toJSON().amount).toBe('100.00');
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const refund = reference();
    refund.markPendingReference({ ...decision, nextCheckAt: minutesAfter(T0, 2) });
    refund.recordReferenceCheck({ at: minutesAfter(T0, 2), nextCheckAt: minutesAfter(T0, 4) });

    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceCheckAt).toEqual(minutesAfter(T0, 4));

    refund.markProcessed({ ...decision, referenceTransactionId: 'tx-bet' });
    expect(refund.status).toBe(Status.Processed);
    expect(refund.nextReferenceCheckAt).toBeUndefined();
  });

  test('PENDING → REJECTED e PENDING → FAILED registram o código', () => {
    const rejected = newWager(Kind.Bet, wallet);
    rejected.reject(RejectionCode.InsufficientFunds, decision);
    const failed = newWager(Kind.Bet, wallet);
    failed.fail(InfrastructureFailureCode.InvariantViolation, decision.at);

    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe(RejectionCode.InsufficientFunds);
    expect(failed.status).toBe(Status.Failed);
    expect(failed.failureCode).toBe(InfrastructureFailureCode.InvariantViolation);
  });

  type Transition = (transaction: WagerTransaction) => void;
  const transitions: Record<string, Transition> = {
    markProcessed: (t) => t.markProcessed({ ...decision, referenceTransactionId: 'tx-bet' }),
    markPendingReference: (t) => t.markPendingReference({ ...decision, nextCheckAt: decision.at }),
    recordReferenceCheck: (t) => t.recordReferenceCheck({ at: decision.at, nextCheckAt: decision.at }),
    reject: (t) => t.reject(RejectionCode.ReferenceNotFound, decision),
    fail: (t) => t.fail(InfrastructureFailureCode.ProcessingFailed, decision.at),
  };
  const terminalStates: Record<string, Transition> = {
    PROCESSED: transitions.markProcessed as Transition,
    REJECTED: transitions.reject as Transition,
    FAILED: transitions.fail as Transition,
  };

  for (const [state, enter] of Object.entries(terminalStates)) {
    for (const [name, transition] of Object.entries(transitions)) {
      test(`${state} é terminal: ${name} lança InvalidTransactionStateError`, () => {
        const refund = reference();
        enter(refund);
        expect(refund.isTerminal()).toBe(true);
        expect(() => transition(refund)).toThrow(InvalidTransactionStateError);
        expect(refund.status).toBe(state as Status);
      });
    }
  }

  test('PENDING_REFERENCE não volta para PENDING_REFERENCE', () => {
    const refund = reference();
    refund.markPendingReference({ ...decision, nextCheckAt: decision.at });
    expect(() => refund.markPendingReference({ ...decision, nextCheckAt: decision.at })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('recordReferenceCheck só vale em PENDING_REFERENCE', () => {
    expect(() => reference().recordReferenceCheck({ at: decision.at, nextCheckAt: decision.at })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('referência no PROCESSED tem de corresponder à existência de referência externa', () => {
    expect(() => reference().markProcessed({ ...decision, referenceTransactionId: undefined })).toThrow(
      DomainInvariantError,
    );
    expect(() =>
      newWager(Kind.Bet, wallet).markProcessed({ ...decision, referenceTransactionId: 'tx-x' }),
    ).toThrow(DomainInvariantError);
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  const bet = newWager(Kind.Bet, wallet);
  const win = newWager(Kind.Win, wallet);
  const refund = newWager(Kind.Refund, wallet, { referenceExternalTransactionId: 'ext-bet' });
  const rollback = newWager(Kind.Rollback, wallet, { referenceExternalTransactionId: 'ext-any' });
  const loss = newWager(Kind.Loss, wallet);

  test('affectsBalance é falso só para LOSS', () => {
    expect([bet, win, refund, rollback, loss].map((t) => t.affectsBalance())).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  test('requiresReference é verdadeiro só para REFUND e ROLLBACK', () => {
    expect([bet, win, refund, rollback, loss].map((t) => t.requiresReference())).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  test('direção no ledger por tipo, com ROLLBACK invertendo a referência', () => {
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(DomainInvariantError);
    expect(() => rollback.ledgerDirectionFor(loss)).toThrow(DomainInvariantError);
    expect(() => loss.ledgerDirectionFor()).toThrow(DomainInvariantError);
  });

  test('tipos aceitos como referência', () => {
    expect(refund.canReference(bet)).toBe(true);
    expect(refund.canReference(win)).toBe(false);
    expect(rollback.canReference(bet)).toBe(true);
    expect(rollback.canReference(win)).toBe(true);
    expect(rollback.canReference(refund)).toBe(true);
    expect(rollback.canReference(rollback)).toBe(false);
    expect(rollback.canReference(loss)).toBe(false);
    expect(win.canReference(bet)).toBe(true);
  });
});
