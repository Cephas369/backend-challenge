import { describe, expect, test } from 'bun:test';
import { DomainInvariantError } from '../../../src/domain/shared/domain-error';
import { RejectionCode } from '../../../src/domain/wagering/failure-code';
import type { ReferenceResolution, SettlementOutcome } from '../../../src/domain/wagering/wager-settlement';
import type {
  CreateWagerTransactionProps,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import {
  found,
  ledgerBalance,
  minutesAfter,
  money,
  newWager,
  nextId,
  openWallet,
  settlement,
  T0,
} from '../../support/domain';

const NOW = minutesAfter(T0, 1);
const NONE: ReferenceResolution = { type: 'NONE' };
const NOT_FOUND: ReferenceResolution = { type: 'NOT_FOUND' };

/** Uma wallet com seu ledger, e o atalho para aplicar transações nela. */
function walletWithLedger(initialBalance = '100.00', options: { playerId?: string } = {}) {
  const { wallet, entries } = openWallet(initialBalance, options);
  const rules = settlement();

  function apply(transaction: WagerTransaction, reference = NONE, now = NOW): SettlementOutcome {
    const outcome = rules.settle({ transaction, wallet, reference, entryId: nextId('entry'), now });
    if (outcome.type === 'PROCESSED' && outcome.entry !== undefined) {
      entries.push(outcome.entry);
    }
    return outcome;
  }

  function processed(kind: Kind, overrides: Partial<CreateWagerTransactionProps> = {}, reference = NONE) {
    const transaction = newWager(kind, wallet, overrides);
    expect(apply(transaction, reference).type).toBe('PROCESSED');
    return transaction;
  }

  return { wallet, entries, apply, processed };
}

function expectConsistent(wallet: Wallet, entries: readonly WalletLedgerEntry[]): void {
  expect(wallet.balance.equals(ledgerBalance(entries))).toBe(true);
}

function expectRejectedWithoutEffect(
  outcome: SettlementOutcome,
  transaction: WagerTransaction,
  code: RejectionCode,
  wallet: Wallet,
  balanceBefore: string,
): void {
  expect(outcome).toEqual({ type: 'REJECTED', code });
  expect(transaction.status).toBe(Status.Rejected);
  expect(transaction.failureCode).toBe(code);
  expect(transaction.observedBalance?.toJSON().amount).toBe(balanceBefore);
  expect(wallet.balance.toJSON().amount).toBe(balanceBefore);
}

describe('BET', () => {
  test('debita com saldo suficiente', () => {
    const { wallet, entries, apply } = walletWithLedger('100.00');
    const bet = newWager(Kind.Bet, wallet, { money: money('25.00') });

    const outcome = apply(bet);

    expect(outcome.type).toBe('PROCESSED');
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(bet.status).toBe(Status.Processed);
    expect(bet.observedBalance?.toJSON().amount).toBe('75.00');
    expectConsistent(wallet, entries);
  });

  test('sem saldo: REJECTED com INSUFFICIENT_FUNDS, sem lançamento nem mudança de versão', () => {
    const { wallet, entries, apply } = walletWithLedger('100.00');
    const bet = newWager(Kind.Bet, wallet, { money: money('100.01') });

    const outcome = apply(bet);

    expectRejectedWithoutEffect(outcome, bet, RejectionCode.InsufficientFunds, wallet, '100.00');
    expect(wallet.version).toBe(1);
    expect(entries).toHaveLength(1);
  });

  test('cenário da seção 8 no domínio: 100.00 e duas apostas de 80.00', () => {
    const { wallet, entries, apply } = walletWithLedger('100.00');
    const first = newWager(Kind.Bet, wallet, { money: money('80.00') });
    const second = newWager(Kind.Bet, wallet, { money: money('80.00') });

    const outcomes = [apply(first), apply(second)];

    expect(outcomes.map((outcome) => outcome.type)).toEqual(['PROCESSED', 'REJECTED']);
    expect(second.failureCode).toBe(RejectionCode.InsufficientFunds);
    expect(wallet.balance.toJSON().amount).toBe('20.00');
    expect(entries.filter((entry) => entry.direction === LedgerDirection.Debit)).toHaveLength(1);
    expectConsistent(wallet, entries);
  });
});

describe('WIN', () => {
  test('sem referência: credita', () => {
    const { wallet, entries, apply } = walletWithLedger('100.00');
    const win = newWager(Kind.Win, wallet, { money: money('50.00') });

    expect(apply(win).type).toBe('PROCESSED');
    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(win.referenceTransactionId).toBeUndefined();
    expectConsistent(wallet, entries);
  });

  test('referenciando a BET da mesma rodada: credita e registra a referência', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const win = newWager(Kind.Win, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('60.00'),
    });

    expect(apply(win, found(bet)).type).toBe('PROCESSED');
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe('135.00');
    expectConsistent(wallet, entries);
  });

  test('referenciando BET de outra rodada: REFERENCE_MISMATCH', () => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const win = newWager(Kind.Win, wallet, { referenceExternalTransactionId: 'bet-1', roundId: 'round-2' });

    expectRejectedWithoutEffect(
      apply(win, found(bet)),
      win,
      RejectionCode.ReferenceMismatch,
      wallet,
      '75.00',
    );
  });

  test('referenciando BET já revertida: REFERENCE_ALREADY_REVERSED', () => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const win = newWager(Kind.Win, wallet, { referenceExternalTransactionId: 'bet-1' });

    expectRejectedWithoutEffect(
      apply(win, found(bet, true)),
      win,
      RejectionCode.ReferenceAlreadyReversed,
      wallet,
      '75.00',
    );
  });
});

describe('LOSS', () => {
  test('registra o resultado sem mover saldo, sem lançamento e sem mudar a versão', () => {
    const { wallet, entries, apply } = walletWithLedger('100.00');
    const loss = newWager(Kind.Loss, wallet, { money: money('0.00') });

    expect(apply(loss)).toEqual({ type: 'PROCESSED', entry: undefined });
    expect(loss.status).toBe(Status.Processed);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(entries).toHaveLength(1);
  });

  test('referenciando BET revertida ainda é registrada, porque não move saldo', () => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const loss = newWager(Kind.Loss, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expect(apply(loss, found(bet, true)).type).toBe('PROCESSED');
    expect(loss.referenceTransactionId).toBe(bet.id);
  });
});

describe('REFUND', () => {
  test('credita o valor da BET processada e registra a referência', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expect(apply(refund, found(bet)).type).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    expectConsistent(wallet, entries);
  });

  test.each<[string, Partial<CreateWagerTransactionProps>, boolean, RejectionCode]>([
    ['valor diferente da BET', { money: money('20.00') }, false, RejectionCode.ReversalAmountMismatch],
    ['BET já revertida', {}, true, RejectionCode.ReferenceAlreadyReversed],
    ['outro provider', { providerId: 'provider-b' }, false, RejectionCode.ReferenceMismatch],
  ])('%s: rejeita sem efeito', (_case, overrides, alreadyReversed, code) => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
      ...overrides,
    });

    expectRejectedWithoutEffect(apply(refund, found(bet, alreadyReversed)), refund, code, wallet, '75.00');
  });

  test('só referencia BET: REFUND de WIN é REFERENCE_KIND_NOT_ALLOWED', () => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const win = processed(Kind.Win, { externalTransactionId: 'win-1', money: money('30.00') });
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'win-1',
      money: money('30.00'),
    });

    expectRejectedWithoutEffect(
      apply(refund, found(win)),
      refund,
      RejectionCode.ReferenceKindNotAllowed,
      wallet,
      '130.00',
    );
  });

  test('referência REJECTED: REFERENCE_NOT_PROCESSED', () => {
    const { wallet, apply } = walletWithLedger('10.00');
    const bet = newWager(Kind.Bet, wallet, { externalTransactionId: 'bet-1', money: money('25.00') });
    expect(apply(bet).type).toBe('REJECTED');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expectRejectedWithoutEffect(
      apply(refund, found(bet)),
      refund,
      RejectionCode.ReferenceNotProcessed,
      wallet,
      '10.00',
    );
  });

  test('referência de outra wallet do mesmo player: REFERENCE_MISMATCH', () => {
    const own = walletWithLedger('100.00');
    const other = walletWithLedger('100.00');
    const betElsewhere = other.processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const refund = newWager(Kind.Refund, own.wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expectRejectedWithoutEffect(
      own.apply(refund, found(betElsewhere)),
      refund,
      RejectionCode.ReferenceMismatch,
      own.wallet,
      '100.00',
    );
  });
});

describe('ROLLBACK', () => {
  test('de BET: credita (devolve a aposta)', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const rollback = newWager(Kind.Rollback, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expect(apply(rollback, found(bet)).type).toBe('PROCESSED');
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expectConsistent(wallet, entries);
  });

  test('de WIN: debita (desfaz o prêmio)', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const win = processed(Kind.Win, { externalTransactionId: 'win-1', money: money('40.00') });
    const rollback = newWager(Kind.Rollback, wallet, {
      referenceExternalTransactionId: 'win-1',
      money: money('40.00'),
    });

    expect(apply(rollback, found(win)).type).toBe('PROCESSED');
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expectConsistent(wallet, entries);
  });

  test('de REFUND: debita (desfaz a devolução)', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const refund = processed(
      Kind.Refund,
      { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1', money: money('25.00') },
      found(bet),
    );
    const rollback = newWager(Kind.Rollback, wallet, {
      referenceExternalTransactionId: 'refund-1',
      money: money('25.00'),
    });

    expect(apply(rollback, found(refund)).type).toBe('PROCESSED');
    expect(entries.at(-1)?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expectConsistent(wallet, entries);
  });

  test('de WIN sem saldo: REVERSAL_INSUFFICIENT_FUNDS, distinto de aposta sem saldo', () => {
    const { wallet, apply, processed } = walletWithLedger('0.00');
    const win = processed(Kind.Win, { externalTransactionId: 'win-1', money: money('40.00') });
    processed(Kind.Bet, { money: money('30.00') });
    const rollback = newWager(Kind.Rollback, wallet, {
      referenceExternalTransactionId: 'win-1',
      money: money('40.00'),
    });

    expectRejectedWithoutEffect(
      apply(rollback, found(win)),
      rollback,
      RejectionCode.ReversalInsufficientFunds,
      wallet,
      '10.00',
    );
  });

  test.each([Kind.Loss, Kind.Rollback])('de %s: REFERENCE_KIND_NOT_ALLOWED', (referencedKind) => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });
    const referenced =
      referencedKind === Kind.Loss
        ? processed(Kind.Loss, { externalTransactionId: 'target', money: money('25.00') })
        : processed(
            Kind.Rollback,
            {
              externalTransactionId: 'target',
              referenceExternalTransactionId: 'bet-1',
              money: money('25.00'),
            },
            found(bet),
          );
    const rollback = newWager(Kind.Rollback, wallet, {
      referenceExternalTransactionId: 'target',
      money: money('25.00'),
    });

    const balance = wallet.balance.toJSON().amount;
    expectRejectedWithoutEffect(
      apply(rollback, found(referenced)),
      rollback,
      RejectionCode.ReferenceKindNotAllowed,
      wallet,
      balance,
    );
  });
});

describe('referência fora de ordem', () => {
  test('referência ausente: PENDING_REFERENCE, sem mexer no saldo, com a próxima busca agendada', () => {
    const { wallet, apply } = walletWithLedger('100.00');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });

    expect(apply(refund, NOT_FOUND)).toEqual({ type: 'AWAITING_REFERENCE', firstTime: true });
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.nextReferenceCheckAt).toEqual(new Date(NOW.getTime() + 1_000));
    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('reprocessada antes do TTL e ainda sem referência: continua aguardando, com backoff', () => {
    const { wallet, apply } = walletWithLedger('100.00');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });
    apply(refund, NOT_FOUND);

    const secondCheck = minutesAfter(T0, 2);
    expect(apply(refund, NOT_FOUND, secondCheck)).toEqual({ type: 'AWAITING_REFERENCE', firstTime: false });
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceCheckAt).toEqual(new Date(secondCheck.getTime() + 2_000));
  });

  test('a referência chega depois: o reprocessamento aplica normalmente', () => {
    const { wallet, entries, apply, processed } = walletWithLedger('100.00');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });
    apply(refund, NOT_FOUND);
    const bet = processed(Kind.Bet, { externalTransactionId: 'bet-1', money: money('25.00') });

    expect(apply(refund, found(bet), minutesAfter(T0, 3)).type).toBe('PROCESSED');
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expectConsistent(wallet, entries);
  });

  test('esgotado o TTL sem referência: REFERENCE_NOT_FOUND', () => {
    const { wallet, apply } = walletWithLedger('100.00');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });
    apply(refund, NOT_FOUND);

    const afterTtl = minutesAfter(T0, 15);
    expectRejectedWithoutEffect(
      apply(refund, NOT_FOUND, afterTtl),
      refund,
      RejectionCode.ReferenceNotFound,
      wallet,
      '100.00',
    );
  });

  test('referência existe mas não termina dentro do TTL: REFERENCE_NOT_PROCESSED', () => {
    const { wallet, apply } = walletWithLedger('100.00');
    const pendingWin = newWager(Kind.Win, wallet, {
      externalTransactionId: 'win-1',
      referenceExternalTransactionId: 'bet-x',
    });
    apply(pendingWin, NOT_FOUND);
    const rollback = newWager(Kind.Rollback, wallet, { referenceExternalTransactionId: 'win-1' });

    expect(apply(rollback, found(pendingWin)).type).toBe('AWAITING_REFERENCE');
    expect(apply(rollback, found(pendingWin), minutesAfter(T0, 15)).type).toBe('REJECTED');
    expect(rollback.failureCode).toBe(RejectionCode.ReferenceNotProcessed);
  });
});

describe('contexto da wallet', () => {
  test('moeda da operação diferente da wallet: REJECTED com CURRENCY_MISMATCH, sem exceção', () => {
    const { wallet, apply } = walletWithLedger('100.00');
    const bet = newWager(Kind.Bet, wallet, { money: money('10.00', 'USD') });

    expectRejectedWithoutEffect(apply(bet), bet, RejectionCode.CurrencyMismatch, wallet, '100.00');
  });

  test('player que não é o dono da wallet: PLAYER_WALLET_MISMATCH', () => {
    const { wallet, apply } = walletWithLedger('100.00', { playerId: 'player-1' });
    const bet = newWager(Kind.Bet, wallet, { playerId: 'player-2' });

    expectRejectedWithoutEffect(apply(bet), bet, RejectionCode.PlayerWalletMismatch, wallet, '100.00');
  });
});

describe('erros de programação', () => {
  test('liquidar transação terminal, de outra wallet ou com resolução incoerente', () => {
    const { wallet, apply, processed } = walletWithLedger('100.00');
    const other = walletWithLedger('100.00');
    const bet = processed(Kind.Bet);

    expect(() => apply(bet)).toThrow(DomainInvariantError);
    expect(() => apply(newWager(Kind.Bet, other.wallet))).toThrow(DomainInvariantError);
    expect(() =>
      apply(newWager(Kind.Refund, wallet, { referenceExternalTransactionId: 'bet-1' }), NONE),
    ).toThrow(DomainInvariantError);
    expect(() => apply(newWager(Kind.Win, wallet), NOT_FOUND)).toThrow(DomainInvariantError);
  });
});
