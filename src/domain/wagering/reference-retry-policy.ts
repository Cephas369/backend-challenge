import { ExponentialBackoff } from '../shared/exponential-backoff';

export interface ReferenceRetryPolicyOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Prazo, contado da criação da transação, para a referência aparecer. */
  readonly ttlMs: number;
  readonly jitter?: number;
  readonly random?: () => number;
}

/**
 * Padrão: 1 s, 2 s, 4 s e assim por diante, até 60 s entre buscas, desistindo 15 min depois da criação. O TTL cobre com folga
 * a janela de retry da mensagem referenciada na fila (5 recebimentos com backoff, ~1 min) e os reenvios
 * HTTP do provedor.
 */
export const DEFAULT_REFERENCE_RETRY_POLICY: ReferenceRetryPolicyOptions = {
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  ttlMs: 15 * 60_000,
  jitter: 0.2,
};

/** Quando procurar de novo a transação referenciada e quando desistir dela. */
export class ReferenceRetryPolicy {
  private readonly backoff: ExponentialBackoff;

  constructor(private readonly options: ReferenceRetryPolicyOptions = DEFAULT_REFERENCE_RETRY_POLICY) {
    this.backoff = new ExponentialBackoff({
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
      ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  /** Momento da próxima busca; `attempt` 1 é a primeira busca depois de entrar em PENDING_REFERENCE. */
  nextCheckAt(attempt: number, now: Date): Date {
    return this.backoff.nextAttemptAt(attempt, now);
  }

  isExpired(createdAt: Date, now: Date): boolean {
    return now.getTime() - createdAt.getTime() >= this.options.ttlMs;
  }
}
