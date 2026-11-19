import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { RejectionCode } from '../../../src/domain/wagering/failure-code';
import { ReferenceRetryPolicy } from '../../../src/domain/wagering/reference-retry-policy';
import { WagerSettlement } from '../../../src/domain/wagering/wager-settlement';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status';
import { createMessagingHarness, type MessagingHarness } from '../../support/messaging';
import { uuid } from '../../support/persistence';

let h: MessagingHarness;

beforeAll(async () => {
  // primeira nova busca 50 ms depois de entrar em PENDING_REFERENCE
  h = await createMessagingHarness('pending_ref', {
    referenceRetry: { initialDelayMs: 50, maxDelayMs: 200 },
  });
});

afterAll(async () => {
  await h?.close();
});

async function refundBeforeBet(walletBalance = '100.00') {
  const wallet = await h.createWallet(walletBalance);
  const betExternalId = uuid();
  const refund = await h.submit.execute(
    h.command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: betExternalId }),
  );
  expect(refund.status).toBe(Status.PendingReference);
  return { wallet, betExternalId, refundId: refund.transactionId };
}

describe('worker de referências pendentes', () => {
  test('REFUND antes da BET: quando a BET chega, o worker aplica o REFUND e publica os eventos', async () => {
    const { wallet, betExternalId, refundId } = await refundBeforeBet();
    await h.submit.execute(h.command(wallet, { externalTransactionId: betExternalId }));

    // a BET processada antecipou a busca: a pendência já está devida
    const round = await h.reprocessor().run();

    const refund = await h.db.unitOfWork.readOnly(({ transactions }) => transactions.findById(refundId));
    expect(round).toMatchObject({ claimed: 1, processed: 1 });
    expect(refund?.status).toBe(Status.Processed);
    expect(await h.balanceOf(wallet.id)).toBe('100.00');
    expect(await h.outboxEventTypes(refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
    expect(await h.reconcile(wallet.id)).toMatchObject({ consistent: true });
  });

  test('ainda sem referência: só é buscada quando vence, e o backoff cresce', async () => {
    const { refundId } = await refundBeforeBet();

    expect((await h.reprocessor().run()).claimed).toBe(0);
    await Bun.sleep(80);
    const round = await h.reprocessor().run();

    const refund = await h.db.unitOfWork.readOnly(({ transactions }) => transactions.findById(refundId));
    expect(round).toMatchObject({ claimed: 1, stillWaiting: 1 });
    expect(refund?.status).toBe(Status.PendingReference);
    expect(refund?.referenceAttempts).toBe(1);
    expect((refund?.nextReferenceCheckAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(50);
  });

  test('esgotado o TTL: REJECTED com REFERENCE_NOT_FOUND e o evento correspondente', async () => {
    const { wallet, refundId } = await refundBeforeBet();
    const shortTtl = new WagerSettlement(
      new ReferenceRetryPolicy({ initialDelayMs: 50, maxDelayMs: 50, ttlMs: 100 }),
    );

    await Bun.sleep(150);
    const round = await h.reprocessor({ settlement: shortTtl }).run();

    const refund = await h.db.unitOfWork.readOnly(({ transactions }) => transactions.findById(refundId));
    expect(round.rejected).toBeGreaterThanOrEqual(1);
    expect(refund?.status).toBe(Status.Rejected);
    expect(refund?.failureCode).toBe(RejectionCode.ReferenceNotFound);
    expect(await h.outboxEventTypes(refundId)).toContain('WagerTransactionRejected');
    expect(await h.balanceOf(wallet.id)).toBe('100.00');
  });

  test('dois workers ao mesmo tempo: cada pendência é aplicada uma única vez', async () => {
    const wallet = await h.createWallet('100.00');
    const tenReais = Money.from({ amount: '10.00', currency: 'BRL' });
    const betIds = Array.from({ length: 8 }, () => uuid());
    for (const betExternalId of betIds) {
      await h.submit.execute(
        h.command(wallet, {
          kind: Kind.Refund,
          referenceExternalTransactionId: betExternalId,
          money: tenReais,
        }),
      );
    }
    for (const betExternalId of betIds) {
      await h.submit.execute(h.command(wallet, { externalTransactionId: betExternalId, money: tenReais }));
    }
    // 8 apostas de 10.00 aplicadas; os 8 REFUNDs esperam o worker
    expect(await h.balanceOf(wallet.id)).toBe('20.00');

    const [first, second] = await Promise.all([
      h.reprocessor({ batchSize: 3 }).run(),
      h.reprocessor({ batchSize: 3 }).run(),
    ]);
    const remaining = await h.reprocessor().run();

    expect(first.processed + second.processed + remaining.processed).toBe(8);
    expect(await h.balanceOf(wallet.id)).toBe('100.00');
    expect(await h.reconcile(wallet.id)).toMatchObject({ consistent: true, checkedEntries: 17 });
  });
});
