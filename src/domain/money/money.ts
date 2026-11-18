import { DomainError } from '../shared/domain-error';

/** DTO do contrato: `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export type InvalidMoneyReason =
  | 'MALFORMED'
  | 'EMPTY'
  | 'NEGATIVE'
  | 'INVALID_SCALE'
  | 'TOO_MANY_DECIMALS'
  | 'OUT_OF_RANGE'
  | 'INVALID_CURRENCY';

export class InvalidMoneyError extends DomainError {
  override readonly code = 'INVALID_MONEY';

  constructor(
    readonly reason: InvalidMoneyReason,
    message: string,
  ) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  override readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`operação entre moedas diferentes: ${expected} e ${actual}`);
  }
}

export class MoneyOutOfRangeError extends DomainError {
  override readonly code = 'MONEY_OUT_OF_RANGE';
}

const SCALE = 2;
const MINOR_UNITS_PER_UNIT = 100n;
/** Mesmo limite da coluna `numeric(20,2)`: 18 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 18;
const MAX_MINOR_UNITS = 10n ** BigInt(MAX_INTEGER_DIGITS + SCALE) - 1n;
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * Valor monetário imutável, com escala fixa de 2 casas e moeda ISO-4217.
 *
 * O valor fica num inteiro de unidades mínimas (centavos) em `bigint`. Soma e subtração são exatas
 * e não existe arredondamento em lugar nenhum: entrada com mais de 2 casas é rejeitada, nunca arredondada.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Contrato de entrada: `amount` é uma string decimal não negativa com exatamente 2 casas
   * (sem sinal, espaços, expoente ou zeros à esquerda) e `currency` tem 3 letras maiúsculas.
   */
  static from(props: MoneyProps): Money {
    const currency = parseCurrency(props.currency);
    return new Money(parseAmount(props.amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.withinRange(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.withinRange(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Mesmo valor e mesma moeda. Moedas diferentes não são iguais (e não lançam erro). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const units = absolute / MINOR_UNITS_PER_UNIT;
    const cents = (absolute % MINOR_UNITS_PER_UNIT).toString().padStart(SCALE, '0');
    return `${negative ? '-' : ''}${units}.${cents}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static withinRange(minorUnits: bigint, currency: string): Money {
    if (minorUnits > MAX_MINOR_UNITS || minorUnits < -MAX_MINOR_UNITS) {
      throw new MoneyOutOfRangeError(
        `valor fora do intervalo representável (${MAX_INTEGER_DIGITS} dígitos inteiros)`,
      );
    }
    return new Money(minorUnits, currency);
  }
}

function parseCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
    throw new InvalidMoneyError(
      'INVALID_CURRENCY',
      'currency deve ser um código ISO-4217 de 3 letras maiúsculas',
    );
  }
  return currency;
}

function parseAmount(amount: unknown): bigint {
  if (typeof amount !== 'string') {
    throw new InvalidMoneyError('MALFORMED', 'amount deve ser uma string decimal');
  }
  if (amount === '') {
    throw new InvalidMoneyError('EMPTY', 'amount não pode ser vazio');
  }
  if (/^-\d/.test(amount)) {
    throw new InvalidMoneyError('NEGATIVE', 'amount não pode ser negativo');
  }
  const match = DECIMAL.exec(amount);
  if (match === null) {
    throw new InvalidMoneyError('MALFORMED', 'amount deve conter só dígitos e um ponto decimal');
  }
  const [, integer = '', fraction] = match;
  if (integer.length > 1 && integer.startsWith('0')) {
    throw new InvalidMoneyError('MALFORMED', 'amount não pode ter zeros à esquerda');
  }
  if (fraction === undefined || fraction.length < SCALE) {
    throw new InvalidMoneyError('INVALID_SCALE', `amount deve ter exatamente ${SCALE} casas decimais`);
  }
  if (fraction.length > SCALE) {
    throw new InvalidMoneyError('TOO_MANY_DECIMALS', `amount tem mais de ${SCALE} casas decimais`);
  }
  if (integer.length > MAX_INTEGER_DIGITS) {
    throw new InvalidMoneyError('OUT_OF_RANGE', `amount tem mais de ${MAX_INTEGER_DIGITS} dígitos inteiros`);
  }
  return BigInt(integer) * MINOR_UNITS_PER_UNIT + BigInt(fraction);
}
