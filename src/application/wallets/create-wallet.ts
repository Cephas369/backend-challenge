import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniquenessViolationError, WalletAlreadyExistsError } from '../errors';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/runtime';

export interface CreateWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly correlationId: string;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
}

export function walletViewOf(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
}

/**
 * Abre a wallet. Saldo inicial positivo gera, na mesma transação SQL, a transação interna OPENING,
 * o crédito no ledger e os eventos correspondentes na outbox.
 */
export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const now = this.clock.now();
    const walletId = this.ids.next();
    const openingTransactionId = this.ids.next();
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openedAt: now,
      openingTransactionId,
      openingEntryId: this.ids.next(),
    });

    try {
      await this.unitOfWork.transaction(async ({ wallets, transactions, ledger, outbox }) => {
        await wallets.insert(wallet);
        if (openingEntry === undefined) {
          return;
        }
        const opening = WagerTransaction.opening({
          id: openingTransactionId,
          walletId,
          playerId: command.playerId,
          money: command.initialBalance,
          at: now,
        });
        await transactions.insert(opening);
        await ledger.append(openingEntry);
        const context = () => ({
          eventId: this.ids.next(),
          correlationId: command.correlationId,
          causationId: undefined,
          occurredAt: now,
        });
        await outbox.append([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context())),
        ]);
      });
    } catch (error) {
      if (error instanceof UniquenessViolationError && error.subject === 'WALLET_PLAYER_CURRENCY') {
        throw new WalletAlreadyExistsError(command.playerId, command.initialBalance.currency, {
          cause: error,
        });
      }
      throw error;
    }
    return walletViewOf(wallet);
  }
}
