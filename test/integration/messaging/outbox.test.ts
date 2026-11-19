import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { ExponentialBackoff } from '../../../src/domain/shared/exponential-backoff';
import { QueueUrls } from '../../../src/infrastructure/sqs/queue-urls';
import { SqsEventPublisher } from '../../../src/infrastructure/sqs/sqs-event-publisher';
import { BalanceProjection, createMessagingHarness, type MessagingHarness } from '../../support/messaging';
import { requiredEnv } from '../../support/unique';

let h: MessagingHarness;

beforeAll(async () => {
  h = await createMessagingHarness('outbox');
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await h.flushOutbox();
});

const bodyOf = (body: string | undefined) =>
  JSON.parse(body ?? '{}') as { eventId: string; eventType: string };

async function publishUntilDry(publisher: ReturnType<MessagingHarness['publisher']>): Promise<number> {
  let published = 0;
  for (;;) {
    const round = await publisher.run();
    published += round.published;
    if (round.attempted === 0) {
      return published;
    }
  }
}

describe('publisher da outbox', () => {
  test('publica os eventos confirmados, com grupo = agregado e dedup = eventId, e marca como publicados', async () => {
    const wallet = await h.createWallet('100.00');

    const round = await h.publisher().run();
    const events = await h.receiveAll(h.queues.urls.eventsQueueUrl);

    expect(round).toEqual({ attempted: 2, published: 2, failed: 0 });
    expect(events.map((event) => bodyOf(event.Body).eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    const balanceChanged = events.find((event) => bodyOf(event.Body).eventType === 'WalletBalanceChanged');
    expect(balanceChanged?.Attributes?.MessageGroupId).toBe(wallet.id);
    expect(balanceChanged?.Attributes?.MessageDeduplicationId).toBe(bodyOf(balanceChanged?.Body).eventId);
    expect(await h.pendingOutbox()).toBe(0);
  });

  test('dois publishers sobre a mesma outbox: lotes disjuntos, todo evento publicado uma vez', async () => {
    await Promise.all(Array.from({ length: 30 }, () => h.createWallet('10.00')));
    const first = h.publisher({ batchSize: 4 });
    const second = h.publisher({ batchSize: 4 });

    const [byFirst, bySecond] = await Promise.all([publishUntilDry(first), publishUntilDry(second)]);
    const eventIds = (await h.receiveAll(h.queues.urls.eventsQueueUrl)).map(
      (event) => bodyOf(event.Body).eventId,
    );

    expect(byFirst + bySecond).toBe(60);
    expect(byFirst).toBeGreaterThan(0);
    expect(bySecond).toBeGreaterThan(0);
    expect(eventIds).toHaveLength(60);
    expect(new Set(eventIds).size).toBe(60);
    expect(await h.pendingOutbox()).toBe(0);
  });

  test('morte entre o envio e o commit: outra instância republica e a duplicata é inofensiva', async () => {
    const wallet = await h.createWallet('100.00');
    await h.submit.execute(h.command(wallet));

    // passos 1 e 2: o banco já confirmou; o publisher envia e morre antes de gravar "publicado"
    const dying = h.publisher({
      afterPublish: async () => {
        throw new Error('processo morreu');
      },
    });
    await expect(dying.run()).rejects.toThrow('processo morreu');
    expect(await h.pendingOutbox()).toBe(4);
    const deliveredBeforeCrash = await h.receiveAll(h.queues.urls.eventsQueueUrl);
    expect(deliveredBeforeCrash).toHaveLength(4);

    // passos 3 e 4: outra instância assume e publica de novo
    expect(await publishUntilDry(h.publisher())).toBe(4);
    expect(await h.pendingOutbox()).toBe(0);
    const deliveredAfter = await h.receiveAll(h.queues.urls.eventsQueueUrl);

    // 5: o consumidor recebe tudo (inclusive repetições) e deduplica por eventId
    const projection = new BalanceProjection(h.db.unitOfWork);
    for (const message of [...deliveredBeforeCrash, ...deliveredAfter, ...deliveredBeforeCrash]) {
      await projection.apply(message);
    }
    expect(projection.balanceOf(wallet.id)).toBe('75.00');
    expect(projection.duplicatesIgnored).toBeGreaterThanOrEqual(4);
  });

  test('com o SQS fora, a mensagem fica pendente com tentativas e erro, e sai quando ele volta', async () => {
    await h.createWallet('5.00');
    const offlineClient = new SQSClient({
      region: requiredEnv('AWS_REGION'),
      endpoint: 'http://127.0.0.1:9',
      maxAttempts: 1,
    });
    const offline = h.publisher(
      { backoff: new ExponentialBackoff({ initialDelayMs: 50, maxDelayMs: 50 }) },
      new SqsEventPublisher(offlineClient, new QueueUrls(offlineClient), 'qualquer.fifo', 500),
    );

    try {
      expect(await offline.run()).toEqual({ attempted: 2, published: 0, failed: 2 });
    } finally {
      offlineClient.destroy();
    }
    const [attempt] = await h.db.orm.em
      .fork()
      .execute<{ attempts: number; last_error: string; due_later: boolean }[]>(
        `select attempts, last_error, next_attempt_at > now() as due_later
           from outbox_messages where published_at is null order by occurred_at limit 1`,
      );
    expect(attempt).toMatchObject({ attempts: 1, due_later: true });
    expect(attempt?.last_error.length).toBeGreaterThan(0);
    expect(await h.publisher().run()).toMatchObject({ attempted: 0 });

    await Bun.sleep(80);
    expect(await publishUntilDry(h.publisher())).toBe(2);
  });
});
