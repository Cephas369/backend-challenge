import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  type InvalidMoneyReason,
  Money,
  MoneyOutOfRangeError,
} from '../../../src/domain/money/money';
import { money } from '../../support/domain';

// sem valor padrão no parâmetro: `undefined` explícito precisa chegar ao Money como está
function reasonFor(amount: unknown, currency: unknown): InvalidMoneyReason | undefined {
  try {
    Money.from({ amount: amount as string, currency: currency as string });
    return undefined;
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      return error.reason;
    }
    throw error;
  }
}

describe('Money: contrato de entrada', () => {
  test.each([
    ['0.00', '0.00'],
    ['25.00', '25.00'],
    ['0.01', '0.01'],
    ['1000.50', '1000.50'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('aceita %p', (amount, expected) => {
    expect(money(amount).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each<[unknown, InvalidMoneyReason]>([
    ['NaN', 'MALFORMED'],
    ['Infinity', 'MALFORMED'],
    ['-Infinity', 'MALFORMED'],
    ['1e3', 'MALFORMED'],
    ['1E3', 'MALFORMED'],
    ['2.5e-1', 'MALFORMED'],
    ['0x10', 'MALFORMED'],
    ['+1.00', 'MALFORMED'],
    [' 1.00', 'MALFORMED'],
    ['1.00 ', 'MALFORMED'],
    ['1,00', 'MALFORMED'],
    ['01.00', 'MALFORMED'],
    ['1.', 'MALFORMED'],
    ['.50', 'MALFORMED'],
    [25, 'MALFORMED'],
    [null, 'MALFORMED'],
    ['', 'EMPTY'],
    ['-1.00', 'NEGATIVE'],
    ['-0.01', 'NEGATIVE'],
    ['1', 'INVALID_SCALE'],
    ['1.5', 'INVALID_SCALE'],
    ['1.001', 'TOO_MANY_DECIMALS'],
    ['0.005', 'TOO_MANY_DECIMALS'],
    ['1000000000000000000.00', 'OUT_OF_RANGE'],
  ])('rejeita %p (%s)', (amount, reason) => {
    expect(reasonFor(amount, 'BRL')).toBe(reason);
  });

  test.each<[unknown]>([['brl'], ['BR'], ['BRLX'], [''], [986], [undefined]])(
    'rejeita a moeda %p',
    (currency) => {
      expect(reasonFor('1.00', currency)).toBe('INVALID_CURRENCY');
    },
  );

  test('nunca arredonda: o valor com terceira casa é rejeitado, não aproximado', () => {
    expect(() => money('10.005')).toThrow(InvalidMoneyError);
  });
});

describe('Money: aritmética exata e imutável', () => {
  test('0.10 + 0.20 é exatamente 0.30', () => {
    expect(money('0.10').add(money('0.20')).equals(money('0.30'))).toBe(true);
  });

  test('valores grandes não perdem precisão', () => {
    const sum = money('99999999999999999.99').add(money('0.01'));
    expect(sum.toJSON().amount).toBe('100000000000000000.00');
  });

  test('operações devolvem instâncias novas e não alteram as originais', () => {
    const original = money('10.00');
    const added = original.add(money('5.00'));
    const subtracted = original.subtract(money('3.00'));

    expect(original.toJSON().amount).toBe('10.00');
    expect(added.toJSON().amount).toBe('15.00');
    expect(subtracted.toJSON().amount).toBe('7.00');
    expect(Object.isFrozen(original)).toBe(true);
  });

  test('subtração pode ficar negativa e serializa com sinal', () => {
    const difference = money('5.00').subtract(money('7.50'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON()).toEqual({ amount: '-2.50', currency: 'BRL' });
    expect(difference.negate().toString()).toBe('2.50 BRL');
  });

  test('zero, positivo e negativo', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
    expect(money('0.01').isPositive()).toBe(true);
  });

  test('comparação', () => {
    expect(money('79.99').isLessThan(money('80.00'))).toBe(true);
    expect(money('80.00').isLessThan(money('80.00'))).toBe(false);
  });

  test('resultado além de 18 dígitos inteiros é recusado', () => {
    expect(() => money('999999999999999999.99').add(money('0.01'))).toThrow(MoneyOutOfRangeError);
  });
});

describe('Money: conflito de moeda', () => {
  const brl = money('10.00', 'BRL');
  const usd = money('10.00', 'USD');

  test.each([
    ['add', () => brl.add(usd)],
    ['subtract', () => brl.subtract(usd)],
    ['isLessThan', () => brl.isLessThan(usd)],
  ])('%s entre moedas diferentes lança erro de domínio', (_operation, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });

  test('equals entre moedas diferentes é falso, sem lançar', () => {
    expect(brl.equals(usd)).toBe(false);
  });
});
