import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { InfrastructureFailureCode } from '../../domain/wagering/failure-code';
import type { WagerSettlement } from '../../domain/wagering/wager-settlement';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import { ConcurrencyConflictError, PersistenceInvariantError, TransientInfrastructureError } from '../errors';
import type { PendingReferenceClaim, UnitOfWork } from '../ports/persistence';
import type { Clock, IdGenerator } from '../ports/runtime';
import { settlementEvents } from './settlement-events';
import { resolveReference } from './submit-wager-transaction';

export interface ReprocessOptions {
  readonly batchSize: number;
  /** Por quanto tempo uma pendência reivindicada fica reservada para quem a pegou. */
  readonly leaseMs: number;
}

export interface ReprocessRound {
  readonly claimed: number;
  readonly processed: number;
  readonly rejected: number;
  readonly stillWaiting: number;
  /** Falha transitória: a reserva vence e outra rodada tenta de novo. */
  readonly deferred: number;
  /** Erro permanente: marcada FAILED para auditoria. */
  readonly failed: number;
  /** Tipo e status de cada transação decidida nesta rodada (para métricas). */
  readonly decisions: readonly { readonly kind: string; readonly status: string }[];
}

type Disposition = 'processed' | 'rejected' | 'stillWaiting' | 'skipped';

interface Reprocessed {
  readonly disposition: Disposition;
  readonly kind?: string;
  readonly status?: string;
}

/**
 * Worker de referências fora de ordem (seção 7.1). Reivindica pendências vencidas sem esperar lock
 * e reprocessa cada uma na sua própria transação, com a mesma ordem de locks do fluxo principal
 * (wallet primeiro) e as mesmas regras. Esgotado o TTL, a regra rejeita com REFERENCE_NOT_FOUND.
 */
export class ReprocessPendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ReprocessOptions,
  ) {}

  async run(): Promise<ReprocessRound> {
    const now = this.clock.now();
    const claims = await this.unitOfWork.transaction(({ transactions }) =>
      transactions.claimDueReferenceChecks(
        now,
        this.options.batchSize,
        new Date(now.getTime() + this.options.leaseMs),
      ),
    );
    const round = {
      claimed: claims.length,
      processed: 0,
      rejected: 0,
      stillWaiting: 0,
      deferred: 0,
      failed: 0,
      decisions: [] as { kind: string; status: string }[],
    };
    for (const claim of claims) {
      try {
        const { disposition, kind, status } = await this.reprocess(claim);
        if (disposition !== 'skipped') {
          round[disposition] += 1;
        }
        if (kind !== undefined && status !== undefined && disposition !== 'stillWaiting') {
          round.decisions.push({ kind, status });
        }
      } catch (error) {
        if (error instanceof TransientInfrastructureError || error instanceof ConcurrencyConflictError) {
          round.deferred += 1;
          continue;
        }
        // não adianta tentar de novo: registra FAILED para auditoria em vez de girar para sempre
        await this.markFailed(
          claim,
          error instanceof PersistenceInvariantError
            ? InfrastructureFailureCode.InvariantViolation
            : InfrastructureFailureCode.ProcessingFailed,
        );
        round.failed += 1;
      }
    }
    return round;
  }

  private reprocess(claim: PendingReferenceClaim): Promise<Reprocessed> {
    return this.unitOfWork.transaction(async ({ wallets, transactions, ledger, outbox }) => {
      const wallet = await wallets.lockById(claim.walletId);
      // relida sob o lock da wallet: outra instância pode ter decidido antes
      const transaction = await transactions.findById(claim.transactionId);
      if (wallet === undefined || transaction?.status !== WagerTransactionStatus.PendingReference) {
        return { disposition: 'skipped' };
      }
      const now = this.clock.now();
      const reference = await resolveReference(transactions, transaction);
      const expectedVersion = wallet.version;
      const outcome = this.settlement.settle({
        transaction,
        wallet,
        reference,
        entryId: this.ids.next(),
        now,
      });

      await transactions.save(transaction);
      if (outcome.type === 'PROCESSED' && outcome.entry !== undefined) {
        await ledger.append(outcome.entry);
        await wallets.saveBalance(wallet, expectedVersion);
      }
      if (outcome.type === 'PROCESSED') {
        await transactions.expediteWaitingFor(transaction.providerId, transaction.externalTransactionId, now);
      }
      const events = settlementEvents(outcome, transaction, wallet, () => ({
        eventId: this.ids.next(),
        // o pedido original já terminou; a continuação assíncrona é correlacionada pela transação
        correlationId: transaction.id,
        causationId: transaction.idempotencyKey,
        occurredAt: now,
      }));
      await outbox.append(events.map((event) => OutboxMessage.enqueue(event)));
      const disposition: Disposition =
        outcome.type === 'PROCESSED'
          ? 'processed'
          : outcome.type === 'REJECTED'
            ? 'rejected'
            : 'stillWaiting';
      return { disposition, kind: transaction.kind, status: transaction.status };
    });
  }

  private async markFailed(claim: PendingReferenceClaim, code: InfrastructureFailureCode): Promise<void> {
    await this.unitOfWork.transaction(async ({ wallets, transactions }) => {
      await wallets.lockById(claim.walletId);
      const transaction = await transactions.findById(claim.transactionId);
      if (transaction?.status === WagerTransactionStatus.PendingReference) {
        transaction.fail(code, this.clock.now());
        await transactions.save(transaction);
      }
    });
  }
}
