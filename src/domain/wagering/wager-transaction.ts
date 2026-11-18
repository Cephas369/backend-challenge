import type { Money } from '../money/money';
import { DomainError, DomainInvariantError } from '../shared/domain-error';
import { LedgerDirection } from '../wallet/ledger-direction';
import type { FailureCode, InfrastructureFailureCode, RejectionCode } from './failure-code';
import { wagerPayloadHash } from './wager-payload';
import { WagerTransactionKind } from './wager-transaction-kind';
import { TERMINAL_STATUSES, WagerTransactionStatus } from './wager-transaction-status';

/** Provider reservado às transações internas (OPENING). */
export const SYSTEM_PROVIDER_ID = 'system';
const OPENING_ROUND_ID = 'wallet-opening';
const OPENING_GAME_ID = 'wallet-opening';

export type InvalidWagerTransactionReason =
  | 'KIND_NOT_ALLOWED'
  | 'RESERVED_PROVIDER'
  | 'MISSING_FIELD'
  | 'REFERENCE_REQUIRED'
  | 'REFERENCE_NOT_ALLOWED'
  | 'SELF_REFERENCE'
  | 'INVALID_AMOUNT';

/** Pedido inválido por contrato: não vira transação (responde como payload inválido). */
export class InvalidWagerTransactionError extends DomainError {
  override readonly code = 'INVALID_WAGER_TRANSACTION';

  constructor(
    readonly reason: InvalidWagerTransactionReason,
    message: string,
  ) {
    super(message);
  }
}

/** Tentativa de transição fora da máquina de estados. Indica erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  override readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(
    readonly from: WagerTransactionStatus,
    readonly to: WagerTransactionStatus,
  ) {
    super(`transição de estado inválida: ${from} → ${to}`);
  }
}

/**
 * Máquina de estados:
 *   PENDING           -> PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE -> PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais e não aparecem como origem.
 */
const TRANSITIONS: ReadonlyMap<WagerTransactionStatus, ReadonlySet<WagerTransactionStatus>> = new Map([
  [
    WagerTransactionStatus.Pending,
    new Set([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.PendingReference,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]),
  ],
  [
    WagerTransactionStatus.PendingReference,
    new Set([
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ]),
  ],
]);

/** Que tipos cada tipo pode referenciar (seção 7, regra 3). */
const REFERENCEABLE_KINDS: Readonly<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Opening]: new Set(),
  [WagerTransactionKind.Bet]: new Set(),
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id da transação no provedor */
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

/** Campos que entram no `payloadHash`. */
export type WagerPayloadFields = Omit<CreateWagerTransactionProps, 'id' | 'idempotencyKey' | 'createdAt'>;

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: FailureCode | undefined;
  readonly processedAt: Date | undefined;
  /** Saldo da wallet quando a transação foi decidida: é o que um replay devolve. */
  readonly observedBalance: Money | undefined;
  /** Quantas vezes a referência já foi procurada de novo depois do primeiro PENDING_REFERENCE. */
  readonly referenceAttempts: number;
  readonly nextReferenceCheckAt: Date | undefined;
  readonly updatedAt: Date;
}

export interface Decision {
  readonly at: Date;
  readonly observedBalance: Money;
}

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** id da transação no provedor */
  readonly referenceExternalTransactionId: string | undefined;
  private readonly createdAtMs: number;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAtMs: number | undefined;
  private _observedBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceCheckAtMs: number | undefined;
  private _updatedAtMs: number;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAtMs = state.createdAt.getTime();
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAtMs = state.processedAt?.getTime();
    this._observedBalance = state.observedBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceCheckAtMs = state.nextReferenceCheckAt?.getTime();
    this._updatedAtMs = state.updatedAt.getTime();
  }

  /** Nasce em PENDING. Valida o contrato, inclusive a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'KIND_NOT_ALLOWED',
        'OPENING é interno e não pode ser submetido',
      );
    }
    if (props.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        'RESERVED_PROVIDER',
        `providerId "${SYSTEM_PROVIDER_ID}" é reservado`,
      );
    }
    for (const field of [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const) {
      requireText(props[field], field);
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined) {
      requireText(reference, 'referenceExternalTransactionId');
    }
    if (REVERSAL_KINDS.has(props.kind) && reference === undefined) {
      throw new InvalidWagerTransactionError(
        'REFERENCE_REQUIRED',
        `${props.kind} exige referenceExternalTransactionId`,
      );
    }
    if (reference !== undefined && REFERENCEABLE_KINDS[props.kind].size === 0) {
      throw new InvalidWagerTransactionError('REFERENCE_NOT_ALLOWED', `${props.kind} não aceita referência`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'SELF_REFERENCE',
        'uma transação não pode referenciar a si mesma',
      );
    }
    if (props.money.isNegative() || (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new InvalidWagerTransactionError(
        'INVALID_AMOUNT',
        'BET, WIN, REFUND e ROLLBACK exigem valor maior que zero; LOSS aceita zero',
      );
    }

    return new WagerTransaction({
      id: props.id,
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: WagerTransaction.payloadHashOf(props),
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: reference,
      createdAt: props.createdAt,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      observedBalance: undefined,
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
      updatedAt: props.createdAt,
    });
  }

  /** Crédito de abertura: interno, só existe com saldo inicial positivo e já nasce PROCESSED. */
  static opening(props: {
    readonly id: string;
    readonly walletId: string;
    readonly playerId: string;
    readonly money: Money;
    readonly at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new DomainInvariantError('OPENING exige saldo inicial positivo');
    }
    const externalTransactionId = `opening:${props.walletId}`;
    const fields: WagerPayloadFields = {
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
    };
    return new WagerTransaction({
      ...fields,
      id: props.id,
      idempotencyKey: `${SYSTEM_PROVIDER_ID}:${externalTransactionId}`,
      payloadHash: WagerTransaction.payloadHashOf(fields),
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: props.at,
      observedBalance: props.money,
      referenceAttempts: 0,
      nextReferenceCheckAt: undefined,
      updatedAt: props.at,
    });
  }

  /** Reconstrução a partir da persistência: não revalida regras de transição. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  /** O mesmo cálculo da criação, para comparar um pedido novo com uma transação existente. */
  static payloadHashOf(fields: WagerPayloadFields): string {
    return wagerPayloadHash({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: fields.money.toJSON(),
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    });
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return toDate(this._processedAtMs);
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceCheckAt(): Date | undefined {
    return toDate(this._nextReferenceCheckAtMs);
  }

  get createdAt(): Date {
    return new Date(this.createdAtMs);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAtMs);
  }

  // transições (lançam InvalidTransactionStateError a partir de estado terminal)

  markProcessed(decision: Decision & { readonly referenceTransactionId: string | undefined }): void {
    const referenced = decision.referenceTransactionId !== undefined;
    if (referenced !== (this.referenceExternalTransactionId !== undefined)) {
      throw new DomainInvariantError(
        'referenceTransactionId deve existir se, e só se, a transação tiver referência',
      );
    }
    this.transitionTo(WagerTransactionStatus.Processed, decision.at);
    this._referenceTransactionId = decision.referenceTransactionId;
    this._processedAtMs = decision.at.getTime();
    this._observedBalance = decision.observedBalance;
    this._nextReferenceCheckAtMs = undefined;
  }

  markPendingReference(decision: Decision & { readonly nextCheckAt: Date }): void {
    if (this.referenceExternalTransactionId === undefined) {
      throw new DomainInvariantError('só uma transação com referência pode aguardar referência');
    }
    this.transitionTo(WagerTransactionStatus.PendingReference, decision.at);
    this._observedBalance = decision.observedBalance;
    this._nextReferenceCheckAtMs = decision.nextCheckAt.getTime();
  }

  /** Registra mais uma busca da referência que não resolveu e agenda a próxima. */
  recordReferenceCheck(check: { readonly at: Date; readonly nextCheckAt: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }
    this._referenceAttempts += 1;
    this._nextReferenceCheckAtMs = check.nextCheckAt.getTime();
    this._updatedAtMs = check.at.getTime();
  }

  reject(code: RejectionCode, decision: Decision): void {
    this.transitionTo(WagerTransactionStatus.Rejected, decision.at);
    this._failureCode = code;
    this._observedBalance = decision.observedBalance;
    this._nextReferenceCheckAtMs = undefined;
  }

  fail(code: InfrastructureFailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed, at);
    this._failureCode = code;
    this._nextReferenceCheckAtMs = undefined;
  }

  // consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false para LOSS, que registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  isReversal(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Indica se `other` pode ser usado como referência deste tipo. REFUND aceita BET; ROLLBACK aceita BET, WIN ou REFUND. */
  canReference(other: WagerTransaction): boolean {
    return REFERENCEABLE_KINDS[this.kind].has(other.kind);
  }

  /** Mesma origem: provider, player, wallet, moeda e rodada (seção 7, regra 2). */
  sharesContextWith(other: WagerTransaction): boolean {
    return (
      this.providerId === other.providerId &&
      this.playerId === other.playerId &&
      this.walletId === other.walletId &&
      this.money.currency === other.money.currency &&
      this.roundId === other.roundId
    );
  }

  /** BET debita; WIN, REFUND e OPENING creditam; ROLLBACK inverte a direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined || !this.canReference(reference)) {
          throw new DomainInvariantError('ROLLBACK precisa de uma referência BET, WIN ou REFUND');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new DomainInvariantError('LOSS não movimenta saldo');
    }
  }

  private transitionTo(next: WagerTransactionStatus, at: Date): void {
    if (!TRANSITIONS.get(this._status)?.has(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
    this._updatedAtMs = at.getTime();
  }
}

function requireText(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidWagerTransactionError('MISSING_FIELD', `${field} é obrigatório`);
  }
}

function toDate(epochMs: number | undefined): Date | undefined {
  return epochMs === undefined ? undefined : new Date(epochMs);
}
