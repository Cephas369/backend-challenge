import { deepFreeze } from '../shared/deep-freeze';

/** Metadados que a aplicação fornece para cada evento. */
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  readonly aggregateId: string;
  readonly data: T;
}

/** Envelope serializado gravado no payload da outbox. */
export interface IntegrationEventEnvelope<T> {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  /** ISO-8601 */
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
}

/**
 * Envelope de evento de integração. Cada evento é uma subclasse que fixa `eventType` e `version`
 * no próprio tipo. `data` é JSON estável (dinheiro como `MoneyProps`, nunca `Money`) e é congelado.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly occurredAtMs: number;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtMs = props.occurredAt.getTime();
    this.data = deepFreeze(structuredClone(props.data));
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: new Date(this.occurredAtMs).toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
