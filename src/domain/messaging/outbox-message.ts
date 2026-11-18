import type { IntegrationEvent } from '../events/integration-event';
import { deepFreeze } from '../shared/deep-freeze';
import { DomainError } from '../shared/domain-error';
import { ExponentialBackoff } from '../shared/exponential-backoff';

export class OutboxMessageAlreadyPublishedError extends DomainError {
  override readonly code = 'OUTBOX_MESSAGE_ALREADY_PUBLISHED';
}

/** 1 s, 2 s, 4 s e assim por diante, até 60 s. Não há limite de tentativas: evento confirmado nunca é descartado. */
export const DEFAULT_OUTBOX_BACKOFF = new ExponentialBackoff({
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  jitter: 0.2,
});

const MAX_ERROR_LENGTH = 500;

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date | undefined;
  readonly publishedAt: Date | undefined;
  readonly lastError: string | undefined;
}

/** Evento confirmado junto com a transação financeira, aguardando publicação. */
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly occurredAtMs: number;
  private _attempts: number;
  private _nextAttemptAtMs: number | undefined;
  private _publishedAtMs: number | undefined;
  private _lastError: string | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = deepFreeze(structuredClone(state.payload));
    this.occurredAtMs = state.occurredAt.getTime();
    this._attempts = state.attempts;
    this._nextAttemptAtMs = state.nextAttemptAt?.getTime();
    this._publishedAtMs = state.publishedAt?.getTime();
    this._lastError = state.lastError;
  }

  /** O id da mensagem é o `eventId`: a mesma publicação repetida carrega o mesmo id. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: { ...event.toJSON() },
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
      lastError: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAtMs === undefined ? undefined : new Date(this._nextAttemptAtMs);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAtMs === undefined ? undefined : new Date(this._publishedAtMs);
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAtMs === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() && (this._nextAttemptAtMs === undefined || this._nextAttemptAtMs <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAtMs = at.getTime();
    this._nextAttemptAtMs = undefined;
  }

  /** Incrementa `attempts` e agenda a próxima tentativa com backoff exponencial. */
  scheduleRetry(now: Date, error?: string, backoff: ExponentialBackoff = DEFAULT_OUTBOX_BACKOFF): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAtMs = backoff.nextAttemptAt(this._attempts, now).getTime();
    this._lastError = error?.slice(0, MAX_ERROR_LENGTH);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(`evento ${this.id} já publicado`);
    }
  }
}
