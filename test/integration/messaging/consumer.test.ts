import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Message } from '@aws-sdk/client-sqs';
import { RejectionCode } from '../../../src/domain/wagering/failure-code';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import {
  CONSUMER_NAME,
  createMessagingHarness,
  type MessagingHarness,
  wagerMessage,
} from '../../support/messaging';
import { uuid } from '../../support/persistence';
import { latch } from '../../support/wait';

let h: MessagingHarness;

beforeAll(async () => {
  h = await createMessagingHarness('consumer', { maxReceiveCount: 2 });
});

afterAll(async () => {
  await h?.close();
});

const reasonOf = (message: Message | undefined) => message?.MessageAttributes?.['dlq-reason']?.StringValue;

/** Segura o lock da wallet noutra sessão, como faria uma transação longa, até `release`. */
async function holdWalletLock(walletId: string) {
  const locked = latch();
  const release = latch();
  const holder = h.db.orm.em.fork().transactional(async (em) => {
    await em.execute('select id from wallets where id = ? for update', [walletId]);
    locked.release();
    await release.promise;
  });
  await locked.promise;
  return {
    release: async () => {
      release.release();
      await holder;
    },
  };
}

describe('consumer de wager-transactions.fifo', () => {
  test('processa pelo mesmo use case, registra na inbox e só então faz ack', async () => {
    const wallet = await h.createWallet('100.00');
    const message = wagerMessage(wallet);
    await h.send(message);

    expect(await h.consumer().pollOnce()).toBe(1);

    const transaction = await h.transaction('provider-a', message.data.externalTransactionId);
    const inbox = await h.db.unitOfWork.readOnly(({ inbox }) => inbox.find(CONSUMER_NAME, message.messageId));
    expect(transaction?.status).toBe(Status.Processed);
    expect(inbox?.isProcessed()).toBe(true);
    expect(await h.balanceOf(wallet.id)).toBe('75.00');
    expect(await h.receiveAll(h.queues.urls.wagerQueueUrl)).toEqual([]);
  });

  test('a mesma mensagem entregue de novo é barrada pela inbox: efeito único', async () => {
    const wallet = await h.createWallet('100.00');
    const message = wagerMessage(wallet);
    await h.send(message);
    await h.send(message);

    expect(await h.drain(h.consumer())).toBe(2);

    expect(await h.debitsOf(wallet.id)).toBe(1);
    expect(await h.balanceOf(wallet.id)).toBe('75.00');
    expect(await h.receiveAll(h.queues.urls.wagerDlqUrl)).toEqual([]);
  });

  test('a mesma transação publicada com outro messageId vira replay: efeito único', async () => {
    const wallet = await h.createWallet('100.00');
    const first = wagerMessage(wallet);
    await h.send(first);
    await h.send({ ...first, messageId: `msg-${uuid()}` });

    await h.drain(h.consumer());

    expect(await h.debitsOf(wallet.id)).toBe(1);
  });

  test('rejeição de negócio é um desfecho: ack, REJECTED gravado, nada na DLQ', async () => {
    const wallet = await h.createWallet('10.00');
    const message = wagerMessage(wallet, { data: { money: { amount: '10.01', currency: 'BRL' } } });
    await h.send(message);

    await h.drain(h.consumer());

    const transaction = await h.transaction('provider-a', message.data.externalTransactionId);
    expect(transaction?.status).toBe(Status.Rejected);
    expect(transaction?.failureCode).toBe(RejectionCode.InsufficientFunds);
    expect(await h.receiveAll(h.queues.urls.wagerDlqUrl)).toEqual([]);
  });

  test.each<[string, (wallet: Awaited<ReturnType<MessagingHarness['createWallet']>>) => unknown, string]>([
    ['corpo que não é JSON', () => '{"messageId": ', 'INVALID_MESSAGE'],
    ['campo obrigatório faltando', (w) => ({ ...wagerMessage(w), occurredAt: undefined }), 'INVALID_MESSAGE'],
    [
      'dinheiro inválido',
      (w) => wagerMessage(w, { data: { money: { amount: '1.001', currency: 'BRL' } } }),
      'INVALID_MESSAGE',
    ],
    ['OPENING vindo da fila', (w) => wagerMessage(w, { data: { kind: 'OPENING' } }), 'INVALID_MESSAGE'],
    ['wallet inexistente', (w) => wagerMessage(w, { data: { walletId: uuid() } }), 'WALLET_NOT_FOUND'],
  ])('%s vai direto para a DLQ com o motivo, sem gravar nada', async (_case, build, reason) => {
    const wallet = await h.createWallet('100.00');
    await h.send(build(wallet), { groupId: wallet.id });

    await h.drain(h.consumer());

    const dead = await h.receiveAll(h.queues.urls.wagerDlqUrl);
    expect(dead).toHaveLength(1);
    expect(reasonOf(dead[0])).toBe(reason);
    expect(await h.balanceOf(wallet.id)).toBe('100.00');
    expect(await h.receiveAll(h.queues.urls.wagerQueueUrl)).toEqual([]);
  });

  test('mesma key com outro payload vai para a DLQ como IDEMPOTENCY_KEY_REUSED', async () => {
    const wallet = await h.createWallet('100.00');
    const original = wagerMessage(wallet);
    await h.send(original);
    await h.drain(h.consumer());

    await h.send({
      ...original,
      messageId: `msg-${uuid()}`,
      data: { ...original.data, money: { amount: '1.00', currency: 'BRL' } },
    });
    await h.drain(h.consumer());

    expect(reasonOf((await h.receiveAll(h.queues.urls.wagerDlqUrl))[0])).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await h.debitsOf(wallet.id)).toBe(1);
  });

  test('mensagens da mesma wallet são aplicadas na ordem em que chegaram', async () => {
    const wallet = await h.createWallet('100.00');
    const first = wagerMessage(wallet, { data: { money: { amount: '80.00', currency: 'BRL' } } });
    const second = wagerMessage(wallet, { data: { money: { amount: '30.00', currency: 'BRL' } } });
    await h.send(first);
    await h.send(second);

    await h.drain(h.consumer());

    expect((await h.transaction('provider-a', first.data.externalTransactionId))?.status).toBe(
      Status.Processed,
    );
    expect((await h.transaction('provider-a', second.data.externalTransactionId))?.failureCode).toBe(
      RejectionCode.InsufficientFunds,
    );
  });
});

describe('falhas transitórias', () => {
  test('lock demorado: a mensagem volta depois do backoff e é processada uma vez', async () => {
    const wallet = await h.createWallet('100.00');
    const message = wagerMessage(wallet);
    await h.send(message);
    const consumer = h.consumer({}, h.db.unitOfWorkWith({ lockTimeoutMs: 100 }));
    const lock = await holdWalletLock(wallet.id);

    expect(await consumer.pollOnce()).toBe(1);
    expect(await h.transaction('provider-a', message.data.externalTransactionId)).toBeUndefined();
    await lock.release();
    await Bun.sleep(1_200);
    expect(await consumer.pollOnce()).toBe(1);

    expect((await h.transaction('provider-a', message.data.externalTransactionId))?.status).toBe(
      Status.Processed,
    );
    expect(await h.debitsOf(wallet.id)).toBe(1);
  });

  test('esgotadas as tentativas, vai para a DLQ com RETRIES_EXHAUSTED e o último motivo', async () => {
    const wallet = await h.createWallet('100.00');
    await h.send(wagerMessage(wallet));
    const consumer = h.consumer({}, h.db.unitOfWorkWith({ lockTimeoutMs: 100 }));
    const lock = await holdWalletLock(wallet.id);

    try {
      await consumer.pollOnce();
      await Bun.sleep(1_200);
      await consumer.pollOnce();
    } finally {
      await lock.release();
    }

    const dead = await h.receiveAll(h.queues.urls.wagerDlqUrl);
    expect(dead).toHaveLength(1);
    expect(reasonOf(dead[0])).toBe('RETRIES_EXHAUSTED');
    expect(dead[0]?.MessageAttributes?.['dlq-detail']?.StringValue).toContain('LOCK_TIMEOUT');
    expect(await h.balanceOf(wallet.id)).toBe('100.00');
  });
});
