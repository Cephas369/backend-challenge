import { describe, expect, test } from 'bun:test';
import type { EventContext } from '../../../src/domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { DomainInvariantError } from '../../../src/domain/shared/domain-error';
import { RejectionCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { minutesAfter, money, newWager, nextId, openWallet, settlement, T0 } from '../../support/domain';

const NOW = minutesAfter(T0, 1);
const context: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: NOW,
};

function processedBet() {
  const { wallet } = openWallet('100.00');
  const bet = newWager(Kind.Bet, wallet, { money: money('25.00') });
  const outcome = settlement().settle({
    transaction: bet,
    wallet,
    reference: { type: 'NONE' },
    entryId: nextId('entry'),
    now: NOW,
  });
  if (outcome.type !== 'PROCESSED' || outcome.entry === undefined) {
    throw new Error('a aposta deveria ter sido processada');
  }
  return { wallet, bet, entry: outcome.entry };
}

describe('envelope dos eventos', () => {
  test('WalletBalanceChanged: tipo e versão vêm da classe, dinheiro como MoneyProps', () => {
    const { wallet, bet, entry } = processedBet();

    const envelope = WalletBalanceChanged.from(wallet, entry, context).toJSON();

    expect(envelope).toEqual({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: NOW.toISOString(),
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: bet.id,
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  test('WagerTransactionProcessed carrega o saldo observado e a referência explícita', () => {
    const { bet } = processedBet();

    const { data, eventType, aggregateId } = WagerTransactionProcessed.from(bet, context).toJSON();

    expect(eventType).toBe('WagerTransactionProcessed');
    expect(aggregateId).toBe(bet.id);
    expect(data).toMatchObject({
      transactionId: bet.id,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '75.00', currency: 'BRL' },
      referenceTransactionId: null,
      processedAt: NOW.toISOString(),
    });
  });

  test('WagerTransactionRejected carrega o failureCode', () => {
    const { wallet } = openWallet('10.00');
    const bet = newWager(Kind.Bet, wallet, { money: money('25.00') });
    settlement().settle({ transaction: bet, wallet, reference: { type: 'NONE' }, entryId: 'e', now: NOW });

    expect(WagerTransactionRejected.from(bet, context).toJSON().data).toMatchObject({
      failureCode: RejectionCode.InsufficientFunds,
      balance: { amount: '10.00', currency: 'BRL' },
      rejectedAt: NOW.toISOString(),
    });
  });

  test('WagerTransactionPendingReference carrega a referência esperada e a próxima busca', () => {
    const { wallet } = openWallet('100.00');
    const refund = newWager(Kind.Refund, wallet, {
      referenceExternalTransactionId: 'bet-1',
      money: money('25.00'),
    });
    settlement().settle({
      transaction: refund,
      wallet,
      reference: { type: 'NOT_FOUND' },
      entryId: 'e',
      now: NOW,
    });

    expect(WagerTransactionPendingReference.from(refund, context).toJSON().data).toMatchObject({
      referenceExternalTransactionId: 'bet-1',
      nextCheckAt: new Date(NOW.getTime() + 1_000).toISOString(),
    });
  });

  test('evento só nasce do estado correspondente', () => {
    const { wallet } = openWallet('100.00');
    const pending = newWager(Kind.Bet, wallet);

    expect(() => WagerTransactionProcessed.from(pending, context)).toThrow(DomainInvariantError);
    expect(() => WagerTransactionRejected.from(pending, context)).toThrow(DomainInvariantError);
    expect(() => WagerTransactionPendingReference.from(pending, context)).toThrow(DomainInvariantError);
  });

  test('causationId ausente não aparece no envelope', () => {
    const { bet } = processedBet();
    const envelope = WagerTransactionProcessed.from(bet, { ...context, causationId: undefined }).toJSON();
    expect(envelope).not.toHaveProperty('causationId');
  });

  test('o data do evento é imutável e independente do objeto de origem', () => {
    const { wallet, entry } = processedBet();
    const event = WalletBalanceChanged.from(wallet, entry, context);

    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => {
      (event.data as { walletVersion: number }).walletVersion = 99;
    }).toThrow(TypeError);
  });
});
