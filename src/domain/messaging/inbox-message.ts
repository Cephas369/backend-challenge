import { DomainError, DomainInvariantError } from '../shared/domain-error';

export class InboxMessageAlreadyProcessedError extends DomainError {
  override readonly code = 'INBOX_MESSAGE_ALREADY_PROCESSED';
}

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt: Date | undefined;
}

/**
 * Registro de mensagem consumida, deduplicado por `(consumerName, messageId)`. É gravado na mesma
 * transação SQL do efeito: se o commit não acontecer, a redelivery processa de novo.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    private readonly receivedAtMs: number,
    private processedAtMs: number | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ['messageId', 'consumerName', 'payloadHash'] as const) {
      if (props[field].trim() === '') {
        throw new DomainInvariantError(`${field} é obrigatório na inbox`);
      }
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt.getTime(),
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt.getTime(),
      state.processedAt?.getTime(),
    );
  }

  get receivedAt(): Date {
    return new Date(this.receivedAtMs);
  }

  get processedAt(): Date | undefined {
    return this.processedAtMs === undefined ? undefined : new Date(this.processedAtMs);
  }

  isProcessed(): boolean {
    return this.processedAtMs !== undefined;
  }

  /** Mesmo `messageId` com conteúdo diferente indica bug no produtor. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InboxMessageAlreadyProcessedError(
        `mensagem ${this.messageId} já processada por ${this.consumerName}`,
      );
    }
    this.processedAtMs = at.getTime();
  }
}
