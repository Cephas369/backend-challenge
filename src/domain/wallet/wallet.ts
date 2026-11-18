import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError, DomainInvariantError } from '../shared/domain-error';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export class InsufficientFundsError extends DomainError {
  override readonly code = 'INSUFFICIENT_FUNDS';
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly openedAt: Date;
  /** Usados só quando o saldo inicial é positivo (transação interna OPENING e seu lançamento). */
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  /** Crédito de abertura; ausente quando o saldo inicial é zero. */
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export interface Movement {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

/**
 * Aggregate root da carteira. Saldo e versão só mudam junto com um lançamento do ledger,
 * criado aqui dentro e devolvido a quem chamou: um não existe sem o outro.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly createdAtMs: number,
    private updatedAtMs: number,
  ) {}

  /** Abre a carteira na versão 1. Saldo inicial positivo gera o crédito de abertura (versão 1 do ledger). */
  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, openedAt } = props;
    if (initialBalance.isNegative()) {
      throw new DomainInvariantError('saldo inicial não pode ser negativo');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      openedAt.getTime(),
      openedAt.getTime(),
    );
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: openedAt,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt.getTime(),
      state.updatedAt.getTime(),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this.updatedAtMs);
  }

  belongsTo(playerId: string): boolean {
    return this.playerId === playerId;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debita e devolve o lançamento. Sem saldo, lança erro e não altera nada. */
  debit(movement: Movement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    if (!this.canDebit(movement.money)) {
      throw new InsufficientFundsError(`saldo insuficiente na wallet ${this.id}`);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  /** Credita e devolve o lançamento. */
  credit(movement: Movement): WalletLedgerEntry {
    this.assertValidMovement(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  private apply(direction: LedgerDirection, movement: Movement): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movement.money)
        : balanceBefore.subtract(movement.money);
    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: movement.at,
    });
    // o estado só muda depois que o lançamento foi validado
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this.updatedAtMs = movement.at.getTime();
    return entry;
  }

  private assertValidMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainInvariantError('movimentação de saldo exige valor positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
