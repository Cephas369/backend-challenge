import { DomainInvariantError } from './domain-error';

export interface ExponentialBackoffOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Fator de crescimento a cada tentativa. Padrão: 2. */
  readonly multiplier?: number;
  /** Fração (0 a 1) do atraso que pode ser descontada ao acaso, para espalhar as retentativas. Padrão: 0. */
  readonly jitter?: number;
  readonly random?: () => number;
}

/** Atraso exponencial com teto e jitter opcional, usado pela outbox e pelas referências pendentes. */
export class ExponentialBackoff {
  private readonly multiplier: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(private readonly options: ExponentialBackoffOptions) {
    this.multiplier = options.multiplier ?? 2;
    this.jitter = options.jitter ?? 0;
    this.random = options.random ?? Math.random;
    if (options.initialDelayMs <= 0 || options.maxDelayMs < options.initialDelayMs) {
      throw new DomainInvariantError('backoff exige 0 < initialDelayMs <= maxDelayMs');
    }
    if (this.multiplier < 1 || this.jitter < 0 || this.jitter > 1) {
      throw new DomainInvariantError('backoff exige multiplier >= 1 e jitter entre 0 e 1');
    }
  }

  /** Atraso antes da tentativa `attempt` (1 = primeira repetição). */
  delayFor(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new DomainInvariantError(`tentativa inválida: ${attempt}`);
    }
    const exponential = this.options.initialDelayMs * this.multiplier ** (attempt - 1);
    const capped = Math.min(exponential, this.options.maxDelayMs);
    return Math.round(capped * (1 - this.jitter * this.random()));
  }

  nextAttemptAt(attempt: number, now: Date): Date {
    return new Date(now.getTime() + this.delayFor(attempt));
  }
}
