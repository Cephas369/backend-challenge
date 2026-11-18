import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import { money, T0 } from '../../support/domain';

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: LedgerDirection.Debit,
    money: money('25.00'),
    balanceBefore: money('100.00'),
    balanceAfter: money('75.00'),
    walletVersion: 2,
    createdAt: T0,
    ...overrides,
  };
}

describe('WalletLedgerEntry', () => {
  test('aceita débito e crédito com a aritmética fechando', () => {
    const debit = WalletLedgerEntry.create(props());
    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceAfter: money('125.00') }),
    );

    expect(debit.isBalanced()).toBe(true);
    expect(debit.signedAmount().toJSON().amount).toBe('-25.00');
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().toJSON().amount).toBe('25.00');
  });

  test.each([
    ['aritmética que não fecha', props({ balanceAfter: money('80.00') })],
    ['direção invertida', props({ direction: LedgerDirection.Credit })],
    ['valor zero', props({ money: money('0.00'), balanceAfter: money('100.00') })],
    [
      'saldo final negativo',
      props({ balanceBefore: money('10.00'), balanceAfter: money('10.00').subtract(money('25.00')) }),
    ],
    ['moeda divergente', props({ balanceAfter: money('75.00', 'USD') })],
    ['versão inválida', props({ walletVersion: 0 })],
  ])('rejeita %s', (_case, invalid) => {
    expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
  });

  test('é estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: LedgerDirection }).direction = LedgerDirection.Credit;
    }).toThrow(TypeError);
    entry.createdAt.setFullYear(2000);
    expect(entry.createdAt).toEqual(T0);
  });

  test('não tem métodos de transição', () => {
    const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.sort()).toEqual(['createdAt', 'isBalanced', 'signedAmount']);
  });

  test('rehydrate reconstrói sem revalidar', () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: money('1.00') }));
    expect(entry.isBalanced()).toBe(false);
  });
});
