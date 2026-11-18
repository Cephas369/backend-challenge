import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { SettlementOutcome } from '../../domain/wagering/wager-settlement';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

/**
 * Eventos de integração de cada desfecho (seção 11):
 * - PROCESSED: WagerTransactionProcessed, mais WalletBalanceChanged quando o saldo mudou (não em LOSS);
 * - REJECTED: WagerTransactionRejected;
 * - AWAITING_REFERENCE: WagerTransactionPendingReference, só na primeira vez.
 */
export function settlementEvents(
  outcome: SettlementOutcome,
  transaction: WagerTransaction,
  wallet: Wallet,
  nextContext: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (outcome.type) {
    case 'PROCESSED':
      return outcome.entry === undefined
        ? [WagerTransactionProcessed.from(transaction, nextContext())]
        : [
            WagerTransactionProcessed.from(transaction, nextContext()),
            WalletBalanceChanged.from(wallet, outcome.entry, nextContext()),
          ];
    case 'REJECTED':
      return [WagerTransactionRejected.from(transaction, nextContext())];
    case 'AWAITING_REFERENCE':
      return outcome.firstTime ? [WagerTransactionPendingReference.from(transaction, nextContext())] : [];
  }
}
