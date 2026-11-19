import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import type { ReferenceResolution, WagerSettlement } from '../../domain/wagering/wager-settlement';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import {
  ConcurrencyConflictError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  PersistenceInvariantError,
  TransientInfrastructureError,
  UniquenessViolationError,
  WalletNotFoundError,
} from '../errors';
import { noopMetrics, type WageringMetrics } from '../ports/metrics';
import type { Repositories, UnitOfWork, WagerTransactionRepository } from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/runtime';
import { settlementEvents } from './settlement-events';

/** Mensagem da fila que originou o pedido: deduplicada pela inbox na mesma transação do efeito. */
export interface SourceMessage {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly correlationId: string;
  /** Presente quando o pedido veio do SQS; ausente na entrada HTTP. */
  readonly message?: SourceMessage | undefined;
}

export interface WagerTransactionResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly failureCode: FailureCode | undefined;
  /** Saldo observado quando a transação foi decidida (o mesmo em todo replay). */
  readonly balance: Money | undefined;
  readonly idempotentReplay: boolean;
}

/** Conflitos de concorrência são raros com a wallet travada; repetir algumas vezes basta. */
const MAX_ATTEMPTS = 3;

/**
 * Submete uma operação de aposta. É o mesmo use case para HTTP e SQS (seção 10).
 *
 * Tudo numa única transação SQL, nesta ordem: inbox (SQS), lock da wallet, idempotência sob o lock,
 * resolução da referência, regras de negócio e gravação da transação, lançamento, saldo e eventos na outbox.
 */
export class SubmitWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics = noopMetrics,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<WagerTransactionResult> {
    // valida o contrato antes de qualquer I/O (lança InvalidWagerTransactionError)
    this.build(command, this.clock.now());
    const requestHash = WagerTransaction.payloadHashOf(command);

    // otimização: o reenvio de algo já decidido não disputa o lock da wallet
    const known = await this.unitOfWork.readOnly(({ transactions }) =>
      transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey),
    );
    if (known !== undefined) {
      const result = replay(known, requestHash);
      this.metrics.duplicateDetected('pre-check');
      return result;
    }

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.unitOfWork.transaction((repositories) =>
          this.process(command, requestHash, repositories),
        );
      } catch (error) {
        if (error instanceof UniquenessViolationError && error.subject !== 'WALLET_PLAYER_CURRENCY') {
          // a mesma key ou o mesmo externalTransactionId foi gravado em paralelo (noutra wallet)
          return this.resolveConcurrentDuplicate(command, requestHash);
        }
        if (error instanceof ConcurrencyConflictError) {
          this.metrics.concurrencyConflict('concurrency-conflict');
          if (attempt < MAX_ATTEMPTS) {
            this.metrics.retryScheduled('submit', 'concurrency-conflict');
            continue;
          }
        }
        if (error instanceof TransientInfrastructureError && error.reason === 'LOCK_TIMEOUT') {
          this.metrics.concurrencyConflict('lock-timeout');
        }
        throw error;
      }
    }
  }

  private async process(
    command: SubmitWagerTransactionCommand,
    requestHash: string,
    { wallets, transactions, ledger, inbox, outbox }: Repositories,
  ): Promise<WagerTransactionResult> {
    const now = this.clock.now();

    let inboxMessage: InboxMessage | undefined;
    if (command.message !== undefined) {
      inboxMessage = InboxMessage.receive({ ...command.message, receivedAt: now });
      if (!(await inbox.tryInsert(inboxMessage))) {
        const result = await this.replayDeliveredMessage(command, requestHash, inbox, transactions);
        this.metrics.duplicateDetected('inbox');
        return result;
      }
    }

    const wallet = await wallets.lockById(command.walletId);
    if (wallet === undefined) {
      throw new WalletNotFoundError(command.walletId);
    }

    // com a wallet travada, esta é a checagem de idempotência que vale
    const existing = await transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (existing !== undefined) {
      const result = replay(existing, requestHash);
      await this.markHandled(inboxMessage, now, inbox);
      this.metrics.duplicateDetected('idempotency-key');
      return result;
    }
    const sameExternalId = await transactions.findByExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (sameExternalId !== undefined) {
      throw new ExternalTransactionConflictError(sameExternalId.id);
    }

    const transaction = this.build(command, now);
    const reference = await resolveReference(transactions, transaction);
    const expectedVersion = wallet.version;
    const outcome = this.settlement.settle({ transaction, wallet, reference, entryId: this.ids.next(), now });

    await transactions.insert(transaction);
    if (outcome.type === 'PROCESSED' && outcome.entry !== undefined) {
      await ledger.append(outcome.entry);
      await wallets.saveBalance(wallet, expectedVersion);
    }
    if (outcome.type === 'PROCESSED') {
      // quem chegou antes e espera por esta transação não precisa aguardar o próximo backoff
      await transactions.expediteWaitingFor(transaction.providerId, transaction.externalTransactionId, now);
    }
    const events = settlementEvents(outcome, transaction, wallet, () => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.message?.messageId ?? command.idempotencyKey,
      occurredAt: now,
    }));
    await outbox.append(events.map((event) => OutboxMessage.enqueue(event)));
    await this.markHandled(inboxMessage, now, inbox);
    return resultOf(transaction, false);
  }

  /** A mesma mensagem já foi processada e confirmada: devolve o que foi decidido naquela vez. */
  private async replayDeliveredMessage(
    command: SubmitWagerTransactionCommand,
    requestHash: string,
    inbox: Repositories['inbox'],
    transactions: WagerTransactionRepository,
  ): Promise<WagerTransactionResult> {
    const message = command.message as SourceMessage;
    const stored = await inbox.find(message.consumerName, message.messageId);
    if (stored !== undefined && !stored.matchesPayload(message.payloadHash)) {
      throw new InboxPayloadMismatchError(message.messageId);
    }
    const existing = await transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (existing === undefined) {
      throw new PersistenceInvariantError(
        undefined,
        `mensagem ${message.messageId} na inbox sem a transação`,
      );
    }
    return replay(existing, requestHash);
  }

  private async resolveConcurrentDuplicate(
    command: SubmitWagerTransactionCommand,
    requestHash: string,
  ): Promise<WagerTransactionResult> {
    const existing = await this.unitOfWork.readOnly(
      async ({ transactions }) =>
        (await transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey)) ??
        (await transactions.findByExternalId(command.providerId, command.externalTransactionId)),
    );
    if (existing === undefined) {
      throw new ConcurrencyConflictError('duplicata concorrente desapareceu antes da releitura');
    }
    if (existing.idempotencyKey !== command.idempotencyKey) {
      throw new ExternalTransactionConflictError(existing.id);
    }
    const result = replay(existing, requestHash);
    this.metrics.duplicateDetected('idempotency-key');
    return result;
  }

  private async markHandled(
    message: InboxMessage | undefined,
    now: Date,
    inbox: Repositories['inbox'],
  ): Promise<void> {
    if (message !== undefined) {
      message.markProcessed(now);
      await inbox.save(message);
    }
  }

  private build(command: SubmitWagerTransactionCommand, now: Date): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
  }
}

/** Busca a referência por (providerId, referenceExternalTransactionId) e se ela já foi revertida. */
export async function resolveReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<ReferenceResolution> {
  const externalId = transaction.referenceExternalTransactionId;
  if (externalId === undefined) {
    return { type: 'NONE' };
  }
  const referenced = await transactions.findByExternalId(transaction.providerId, externalId);
  if (referenced === undefined) {
    return { type: 'NOT_FOUND' };
  }
  return {
    type: 'FOUND',
    transaction: referenced,
    alreadyReversed: await transactions.hasProcessedReversal(referenced.id),
  };
}

/** Mesma key: replay se o payload for o mesmo, conflito se não for. */
function replay(existing: WagerTransaction, requestHash: string): WagerTransactionResult {
  if (!existing.matchesPayload(requestHash)) {
    throw new IdempotencyConflictError(existing.id);
  }
  return resultOf(existing, true);
}

export function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balance: transaction.observedBalance,
    idempotentReplay,
  };
}
