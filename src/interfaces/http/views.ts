import type { WagerTransactionResult } from '../../application/wagering/submit-wager-transaction';
import type { WalletView } from '../../application/wallets/create-wallet';
import type { ReconciliationReport } from '../../application/wallets/wallet-queries';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';

/** Formas de resposta da API: dinheiro sempre como `MoneyProps` (string decimal + moeda). */

export function walletResponse(view: WalletView) {
  return { id: view.id, playerId: view.playerId, balance: view.balance.toJSON(), version: view.version };
}

/** Status HTTP de um resultado de transação. Replays repetem o mesmo status. */
export function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function transactionResultResponse(result: WagerTransactionResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
    balance: result.balance?.toJSON() ?? null,
    idempotentReplay: result.idempotentReplay,
  };
}

export function transactionResponse(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    balance: transaction.observedBalance?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export function ledgerEntryResponse(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function reconciliationResponse(report: ReconciliationReport) {
  return {
    walletId: report.walletId,
    storedBalance: report.storedBalance.toJSON(),
    calculatedBalance: report.calculatedBalance.toJSON(),
    difference: report.difference.toJSON(),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
    issues: report.issues,
  };
}
