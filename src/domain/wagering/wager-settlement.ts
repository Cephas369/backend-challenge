import { DomainInvariantError } from '../shared/domain-error';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { Wallet } from '../wallet/wallet';
import type { WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { RejectionCode } from './failure-code';
import type { ReferenceRetryPolicy } from './reference-retry-policy';
import type { WagerTransaction } from './wager-transaction';
import { WagerTransactionStatus } from './wager-transaction-status';

/** O que a aplicação encontrou ao procurar a referência por `(providerId, referenceExternalTransactionId)`. */
export type ReferenceResolution =
  | { readonly type: 'NONE' }
  | { readonly type: 'NOT_FOUND' }
  | {
      readonly type: 'FOUND';
      readonly transaction: WagerTransaction;
      /** Já existe um REFUND ou ROLLBACK PROCESSED apontando para ela. */
      readonly alreadyReversed: boolean;
    };

export type SettlementOutcome =
  | { readonly type: 'PROCESSED'; readonly entry: WalletLedgerEntry | undefined }
  | { readonly type: 'REJECTED'; readonly code: RejectionCode }
  /** `firstTime`: acabou de entrar em PENDING_REFERENCE (é quando o evento é publicado). */
  | { readonly type: 'AWAITING_REFERENCE'; readonly firstTime: boolean };

export interface SettleCommand {
  /** Em PENDING (chegou agora) ou PENDING_REFERENCE (reprocessamento). */
  readonly transaction: WagerTransaction;
  /** A wallet da transação, já travada pela aplicação. */
  readonly wallet: Wallet;
  readonly reference: ReferenceResolution;
  /** id do lançamento, caso a transação mova saldo. */
  readonly entryId: string;
  readonly now: Date;
}

type ReferenceDecision =
  | { readonly type: 'WAIT' }
  | { readonly type: 'REJECT'; readonly code: RejectionCode }
  | { readonly type: 'USE'; readonly reference: WagerTransaction };

/**
 * Regras de BET, WIN, LOSS, REFUND e ROLLBACK (seção 7). Decide o desfecho, aplica as transições na
 * transação e na wallet e devolve o que aconteceu; persistir e publicar é com a aplicação.
 */
export class WagerSettlement {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  settle(command: SettleCommand): SettlementOutcome {
    const { transaction, wallet, now } = command;
    this.assertSettleable(command);

    if (!wallet.belongsTo(transaction.playerId)) {
      return this.reject(command, RejectionCode.PlayerWalletMismatch);
    }
    if (transaction.money.currency !== wallet.currency) {
      return this.reject(command, RejectionCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (command.reference.type !== 'NONE') {
      const decision = this.evaluateReference(transaction, command.reference, now);
      if (decision.type === 'WAIT') {
        return this.awaitReference(command);
      }
      if (decision.type === 'REJECT') {
        return this.reject(command, decision.code);
      }
      reference = decision.reference;
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed({
        referenceTransactionId: reference?.id,
        at: now,
        observedBalance: wallet.balance,
      });
      return { type: 'PROCESSED', entry: undefined };
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      // reverter um crédito sem saldo é operacionalmente diferente de apostar sem saldo
      return this.reject(
        command,
        transaction.isReversal() ? RejectionCode.ReversalInsufficientFunds : RejectionCode.InsufficientFunds,
      );
    }
    const movement = {
      entryId: command.entryId,
      transactionId: transaction.id,
      money: transaction.money,
      at: now,
    };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    transaction.markProcessed({
      referenceTransactionId: reference?.id,
      at: now,
      observedBalance: wallet.balance,
    });
    return { type: 'PROCESSED', entry };
  }

  private evaluateReference(
    transaction: WagerTransaction,
    resolution: Exclude<ReferenceResolution, { readonly type: 'NONE' }>,
    now: Date,
  ): ReferenceDecision {
    if (resolution.type === 'NOT_FOUND' || !resolution.transaction.isTerminal()) {
      if (!this.retryPolicy.isExpired(transaction.createdAt, now)) {
        return { type: 'WAIT' };
      }
      return {
        type: 'REJECT',
        code:
          resolution.type === 'NOT_FOUND'
            ? RejectionCode.ReferenceNotFound
            : RejectionCode.ReferenceNotProcessed,
      };
    }

    const reference = resolution.transaction;
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { type: 'REJECT', code: RejectionCode.ReferenceNotProcessed };
    }
    if (!transaction.canReference(reference)) {
      return { type: 'REJECT', code: RejectionCode.ReferenceKindNotAllowed };
    }
    if (!transaction.sharesContextWith(reference)) {
      return { type: 'REJECT', code: RejectionCode.ReferenceMismatch };
    }
    // uma referência já revertida não serve de base para mover saldo de novo (nem para pagar um WIN)
    if (transaction.affectsBalance() && resolution.alreadyReversed) {
      return { type: 'REJECT', code: RejectionCode.ReferenceAlreadyReversed };
    }
    if (transaction.isReversal() && !transaction.money.equals(reference.money)) {
      return { type: 'REJECT', code: RejectionCode.ReversalAmountMismatch };
    }
    return { type: 'USE', reference };
  }

  private awaitReference(command: SettleCommand): SettlementOutcome {
    const { transaction, wallet, now } = command;
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference({
        at: now,
        observedBalance: wallet.balance,
        nextCheckAt: this.retryPolicy.nextCheckAt(1, now),
      });
      return { type: 'AWAITING_REFERENCE', firstTime: true };
    }
    // esta busca é a de número referenceAttempts + 1; agenda a seguinte
    transaction.recordReferenceCheck({
      at: now,
      nextCheckAt: this.retryPolicy.nextCheckAt(transaction.referenceAttempts + 2, now),
    });
    return { type: 'AWAITING_REFERENCE', firstTime: false };
  }

  private reject(command: SettleCommand, code: RejectionCode): SettlementOutcome {
    command.transaction.reject(code, { at: command.now, observedBalance: command.wallet.balance });
    return { type: 'REJECTED', code };
  }

  private assertSettleable({ transaction, wallet, reference }: SettleCommand): void {
    if (transaction.isTerminal()) {
      throw new DomainInvariantError(`a transação ${transaction.id} já está em estado terminal`);
    }
    if (transaction.walletId !== wallet.id) {
      throw new DomainInvariantError(`a transação ${transaction.id} não pertence à wallet ${wallet.id}`);
    }
    const hasReference = transaction.referenceExternalTransactionId !== undefined;
    if (hasReference !== (reference.type !== 'NONE')) {
      throw new DomainInvariantError('a resolução da referência não corresponde à transação');
    }
  }
}
