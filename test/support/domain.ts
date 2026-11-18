import { Money } from '../../src/domain/money/money';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import { type ReferenceResolution, WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { Wallet } from '../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';

let sequence = 0;

/** Ids legíveis e únicos dentro da execução. */
export function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const T0 = new Date('2026-11-18T12:00:00.000Z');

export function minutesAfter(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

export function money(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

/** Wallet aberta com o saldo inicial informado, mais o crédito de abertura (quando há). */
export function openWallet(
  initialBalance = '100.00',
  options: { readonly playerId?: string; readonly currency?: string } = {},
): { wallet: Wallet; entries: WalletLedgerEntry[] } {
  const { wallet, openingEntry } = Wallet.open({
    id: nextId('wallet'),
    playerId: options.playerId ?? 'player-1',
    initialBalance: money(initialBalance, options.currency),
    openedAt: T0,
    openingTransactionId: nextId('opening'),
    openingEntryId: nextId('entry'),
  });
  return { wallet, entries: openingEntry === undefined ? [] : [openingEntry] };
}

export function newWager(
  kind: WagerTransactionKind,
  wallet: Wallet,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  return WagerTransaction.create({
    id: nextId('tx'),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: money('10.00'),
    createdAt: T0,
    ...overrides,
    providerId,
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
  });
}

/** Política sem jitter: os instantes agendados ficam previsíveis nos testes. */
export function predictableRetryPolicy(): ReferenceRetryPolicy {
  return new ReferenceRetryPolicy({ initialDelayMs: 1_000, maxDelayMs: 60_000, ttlMs: 15 * 60_000 });
}

export function settlement(): WagerSettlement {
  return new WagerSettlement(predictableRetryPolicy());
}

export function found(transaction: WagerTransaction, alreadyReversed = false): ReferenceResolution {
  return { type: 'FOUND', transaction, alreadyReversed };
}

/** Invariante final: o saldo da wallet é igual ao saldo reconstruído pelo ledger. */
export function ledgerBalance(entries: readonly WalletLedgerEntry[], currency = 'BRL'): Money {
  return entries.reduce((balance, entry) => balance.add(entry.signedAmount()), Money.zero(currency));
}
