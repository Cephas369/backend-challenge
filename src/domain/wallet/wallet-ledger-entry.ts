import type { Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { LedgerDirection } from './ledger-direction';

export class InvalidLedgerEntryError extends DomainError {
  override readonly code = 'INVALID_LEDGER_ENTRY';
}

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Versão da wallet depois deste lançamento: encadeia o ledger sem bifurcação. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger. Não tem campo mutável nem método de transição: a instância é congelada
 * e a data fica guardada como instante, porque `Date` é mutável.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  private readonly createdAtMs: number;

  private constructor(state: LedgerEntryState) {
    this.id = state.id;
    this.walletId = state.walletId;
    this.transactionId = state.transactionId;
    this.direction = state.direction;
    this.money = state.money;
    this.balanceBefore = state.balanceBefore;
    this.balanceAfter = state.balanceAfter;
    this.walletVersion = state.walletVersion;
    this.createdAtMs = state.createdAt.getTime();
    Object.freeze(this);
  }

  /** Valida o lançamento, inclusive a aritmética `balanceBefore ± money === balanceAfter`. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (balanceBefore.currency !== money.currency || balanceAfter.currency !== money.currency) {
      throw new InvalidLedgerEntryError('valor e saldos do lançamento devem estar na mesma moeda');
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('o valor do lançamento deve ser positivo');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('um lançamento não pode produzir nem partir de saldo negativo');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('walletVersion deve ser um inteiro a partir de 1');
    }
    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balanceBefore ± money não fecha com balanceAfter');
    }
    return entry;
  }

  /** Reconstrução a partir da persistência: não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito do lançamento no saldo: positivo para crédito, negativo para débito. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
