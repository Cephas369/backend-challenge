import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError } from '../../../src/domain/money/money';
import { DomainInvariantError } from '../../../src/domain/shared/domain-error';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { InsufficientFundsError, Wallet } from '../../../src/domain/wallet/wallet';
import { ledgerBalance, minutesAfter, money, nextId, openWallet, T0 } from '../../support/domain';

function movement(amount: string, currency = 'BRL') {
  return {
    entryId: nextId('entry'),
    transactionId: nextId('tx'),
    money: money(amount, currency),
    at: minutesAfter(T0, 1),
  };
}

describe('Wallet: abertura', () => {
  test('com saldo inicial: versão 1 e crédito de abertura correspondente', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: money('1000.00'),
      openedAt: T0,
      openingTransactionId: 'opening-1',
      openingEntryId: 'entry-1',
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry).toMatchObject({
      walletId: 'wallet-1',
      transactionId: 'opening-1',
      direction: LedgerDirection.Credit,
      walletVersion: 1,
    });
    expect(openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.toJSON().amount).toBe('1000.00');
  });

  test('com saldo zero: versão 1 e nenhum lançamento', () => {
    const { wallet, entries } = openWallet('0.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(entries).toEqual([]);
  });

  test('saldo inicial negativo é recusado', () => {
    const negative = money('5.00').subtract(money('10.00'));
    expect(() =>
      Wallet.open({
        id: 'wallet-x',
        playerId: 'player-1',
        initialBalance: negative,
        openedAt: T0,
        openingTransactionId: 'opening-x',
        openingEntryId: 'entry-x',
      }),
    ).toThrow(DomainInvariantError);
  });
});

describe('Wallet: movimentações', () => {
  test('débito reduz o saldo, incrementa a versão e devolve o lançamento coerente', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.toJSON().amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe('100.00');
    expect(entry.balanceAfter.toJSON().amount).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
    expect(wallet.updatedAt).toEqual(minutesAfter(T0, 1));
  });

  test('crédito aumenta o saldo e incrementa a versão', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.credit(movement('40.00'));

    expect(wallet.balance.toJSON().amount).toBe('140.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('débito pode zerar o saldo, mas não passar dele', () => {
    const { wallet } = openWallet('100.00');

    wallet.debit(movement('100.00'));
    expect(wallet.balance.isZero()).toBe(true);
    expect(() => wallet.debit(movement('0.01'))).toThrow(InsufficientFundsError);
  });

  test('débito sem saldo lança erro e não altera saldo nem versão', () => {
    const { wallet } = openWallet('100.00');

    expect(wallet.canDebit(money('100.01'))).toBe(false);
    expect(() => wallet.debit(movement('100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('moeda diferente da wallet lança erro e não altera nada', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.credit(movement('10.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(movement('10.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('movimentação de valor zero não é uma mudança de saldo e é recusada', () => {
    const { wallet } = openWallet('100.00');

    expect(() => wallet.credit(movement('0.00'))).toThrow(DomainInvariantError);
    expect(wallet.version).toBe(1);
  });

  test('a versão encadeia os lançamentos e o saldo bate com o ledger reconstruído', () => {
    const { wallet, entries } = openWallet('100.00');

    entries.push(wallet.debit(movement('30.00')));
    entries.push(wallet.credit(movement('12.50')));
    entries.push(wallet.debit(movement('82.50')));

    expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(wallet.version).toBe(4);
    expect(wallet.balance.equals(ledgerBalance(entries))).toBe(true);
    for (const [index, entry] of entries.entries()) {
      const previous = entries[index - 1];
      if (previous !== undefined) {
        expect(entry.balanceBefore.equals(previous.balanceAfter)).toBe(true);
      }
    }
  });
});

describe('Wallet: reidratação', () => {
  test('reconstrói o estado persistido sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: money('975.00'),
      version: 7,
      createdAt: T0,
      updatedAt: minutesAfter(T0, 5),
    });

    expect(wallet.version).toBe(7);
    expect(wallet.balance.toJSON().amount).toBe('975.00');
    expect(wallet.belongsTo('player-9')).toBe(true);
    expect(wallet.belongsTo('player-1')).toBe(false);
  });

  test('datas expostas são cópias: alterá-las não muda a wallet', () => {
    const { wallet } = openWallet();
    wallet.createdAt.setFullYear(2000);
    expect(wallet.createdAt).toEqual(T0);
  });
});
