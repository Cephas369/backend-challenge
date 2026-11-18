import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../src/domain/events/wallet-balance-changed';
import { InboxMessage, InboxMessageAlreadyProcessedError } from '../../../src/domain/messaging/inbox-message';
import {
  OutboxMessage,
  OutboxMessageAlreadyPublishedError,
} from '../../../src/domain/messaging/outbox-message';
import { DomainInvariantError } from '../../../src/domain/shared/domain-error';
import { ExponentialBackoff } from '../../../src/domain/shared/exponential-backoff';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { minutesAfter, money, nextId, openWallet, T0 } from '../../support/domain';

const NOW = minutesAfter(T0, 1);

function secondsAfter(base: Date, seconds: number): Date {
  return new Date(base.getTime() + seconds * 1_000);
}

describe('ExponentialBackoff', () => {
  const backoff = new ExponentialBackoff({ initialDelayMs: 1_000, maxDelayMs: 8_000 });

  test('dobra a cada tentativa até o teto', () => {
    expect([1, 2, 3, 4, 5, 10, 1000].map((attempt) => backoff.delayFor(attempt))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000,
    ]);
  });

  test('jitter só reduz o atraso, dentro da fração configurada', () => {
    const lowest = new ExponentialBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitter: 0.2,
      random: () => 1,
    });
    const highest = new ExponentialBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 8_000,
      jitter: 0.2,
      random: () => 0,
    });

    expect(lowest.delayFor(3)).toBe(3_200);
    expect(highest.delayFor(3)).toBe(4_000);
  });

  test('configuração e tentativa inválidas são erro de programação', () => {
    expect(() => new ExponentialBackoff({ initialDelayMs: 0, maxDelayMs: 1 })).toThrow(DomainInvariantError);
    expect(() => new ExponentialBackoff({ initialDelayMs: 5, maxDelayMs: 1 })).toThrow(DomainInvariantError);
    expect(() => backoff.delayFor(0)).toThrow(DomainInvariantError);
  });
});

describe('InboxMessage', () => {
  const received = () =>
    InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wagering',
      payloadHash: 'hash-1',
      receivedAt: T0,
    });

  test('nasce não processada e marca o processamento uma única vez', () => {
    const message = received();
    expect(message.isProcessed()).toBe(false);

    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(NOW);
    expect(() => message.markProcessed(NOW)).toThrow(InboxMessageAlreadyProcessedError);
  });

  test('compara o conteúdo pelo hash', () => {
    expect(received().matchesPayload('hash-1')).toBe(true);
    expect(received().matchesPayload('hash-2')).toBe(false);
  });

  test('exige identificação completa', () => {
    expect(() =>
      InboxMessage.receive({ messageId: ' ', consumerName: 'wagering', payloadHash: 'h', receivedAt: T0 }),
    ).toThrow(DomainInvariantError);
  });
});

describe('OutboxMessage', () => {
  function enqueued(): OutboxMessage {
    const { wallet } = openWallet('100.00');
    const entry = wallet.credit({
      entryId: nextId('entry'),
      transactionId: 'tx-1',
      money: money('5.00'),
      at: NOW,
    });
    const event = WalletBalanceChanged.from(wallet, entry, {
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt: NOW,
    });
    return OutboxMessage.enqueue(event);
  }

  test('enqueue guarda o envelope do evento, com o eventId como id, e fica devido na hora', () => {
    const message = enqueued();

    expect(message.id).toBe('event-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({
      eventId: 'event-1',
      eventType: 'WalletBalanceChanged',
      version: 1,
      data: { direction: LedgerDirection.Credit },
    });
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
    expect(message.isDue(secondsAfter(NOW, -1))).toBe(false);
    expect(Object.isFrozen(message.payload)).toBe(true);
  });

  test('scheduleRetry incrementa as tentativas e adia com backoff exponencial', () => {
    const message = enqueued();
    const backoff = new ExponentialBackoff({ initialDelayMs: 1_000, maxDelayMs: 60_000 });

    message.scheduleRetry(NOW, 'SQS indisponível', backoff);
    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(secondsAfter(NOW, 1));
    expect(message.lastError).toBe('SQS indisponível');
    expect(message.isDue(NOW)).toBe(false);

    message.scheduleRetry(NOW, 'de novo', backoff);
    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(secondsAfter(NOW, 2));
  });

  test('o erro guardado é truncado', () => {
    const message = enqueued();
    message.scheduleRetry(NOW, 'x'.repeat(2_000));
    expect(message.lastError).toHaveLength(500);
  });

  test('depois de publicada não fica devida nem aceita nova transição', () => {
    const message = enqueued();
    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(secondsAfter(NOW, 3600))).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
    expect(() => message.markPublished(NOW)).toThrow(OutboxMessageAlreadyPublishedError);
    expect(() => message.scheduleRetry(NOW)).toThrow(OutboxMessageAlreadyPublishedError);
  });
});
