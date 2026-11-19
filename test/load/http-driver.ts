import type { HttpOutcome, Workload } from './workload';

export async function postTransaction(
  baseUrl: string,
  idempotencyKey: string,
  body: unknown,
): Promise<HttpOutcome> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    return {
      status: response.status,
      latencyMs: performance.now() - startedAt,
      body: parsed,
      retryAfterMs: Number(response.headers.get('retry-after') ?? '1') * 1_000,
    };
  } catch {
    return {
      status: 'connection-error',
      latencyMs: performance.now() - startedAt,
      body: {},
      retryAfterMs: 1_000,
    };
  }
}

/** 503 e queda de conexão: o contrato manda reenviar com a mesma Idempotency-Key. */
function retryable(outcome: HttpOutcome): boolean {
  return outcome.status === 'connection-error' || outcome.status === 503;
}

export function outcomeLabel(outcome: HttpOutcome): string {
  if (outcome.status === 'connection-error') {
    return 'erro de conexão';
  }
  const detail = outcome.body.failureCode ?? outcome.body.status ?? outcome.body.code ?? '';
  const replay = outcome.body.idempotentReplay === true ? ' (replay)' : '';
  return `${outcome.status} ${String(detail)}${replay}`.trim();
}

export interface ClosedLoopOptions {
  /** URLs das instâncias; cada tentativa vai para a próxima (round-robin, como um balanceador). */
  readonly targets: readonly string[];
  readonly concurrency: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly maxRetries: number;
  readonly workload: Workload;
  /** Chamado quando a janela de medição começa (fim do aquecimento). */
  readonly onWindowStart?: () => void;
}

export interface ClosedLoopResult {
  readonly windowStartedAt: Date;
  readonly windowEndedAt: Date;
  readonly windowSeconds: number;
  /** Operações cujo desfecho final chegou dentro da janela. */
  readonly completed: number;
  /** Tentativas iniciadas dentro da janela. */
  readonly attempts: number;
  readonly latencies: number[];
  readonly newLatencies: number[];
  readonly replayLatencies: number[];
  readonly outcomes: Map<string, number>;
  /** Tentativas com 5xx ou sem resposta. */
  readonly failedAttempts: number;
  /** Reenvios por 503 ou queda de conexão. */
  readonly retries: number;
}

/**
 * Carga em laço fechado: cada usuário virtual manda uma operação, espera a resposta (reenviando com a
 * mesma key depois do `Retry-After` quando ela é retentável) e só então manda a próxima. O que acontece
 * durante o aquecimento não entra nas estatísticas.
 */
export async function runClosedLoop(options: ClosedLoopOptions): Promise<ClosedLoopResult> {
  const windowStart = performance.now() + options.warmupMs;
  const windowEnd = windowStart + options.durationMs;
  const inWindow = (instant: number) => instant >= windowStart && instant < windowEnd;
  let windowStartedAt = new Date(Date.now() + options.warmupMs);
  const timer = setTimeout(() => {
    windowStartedAt = new Date();
    options.onWindowStart?.();
  }, options.warmupMs);

  const latencies: number[] = [];
  const newLatencies: number[] = [];
  const replayLatencies: number[] = [];
  const outcomes = new Map<string, number>();
  let attempts = 0;
  let completed = 0;
  let failedAttempts = 0;
  let retries = 0;
  let nextTarget = 0;

  const virtualUser = async (vu: number): Promise<void> => {
    while (performance.now() < windowEnd) {
      const operation = options.workload.next(vu);
      let outcome: HttpOutcome | undefined;
      for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
        const target = options.targets[nextTarget++ % options.targets.length] ?? '';
        const sentAt = performance.now();
        outcome = await postTransaction(target, operation.key, operation.body);
        const measured = inWindow(sentAt);
        if (measured) {
          attempts += 1;
          latencies.push(outcome.latencyMs);
          (outcome.body.idempotentReplay === true ? replayLatencies : newLatencies).push(outcome.latencyMs);
          const label = outcomeLabel(outcome);
          outcomes.set(label, (outcomes.get(label) ?? 0) + 1);
          if (outcome.status === 'connection-error' || outcome.status >= 500) {
            failedAttempts += 1;
          }
        }
        if (!retryable(outcome)) {
          break;
        }
        if (measured) {
          retries += 1;
        }
        await Bun.sleep(outcome.retryAfterMs);
      }
      if (outcome !== undefined) {
        options.workload.settle(operation, outcome);
        if (inWindow(performance.now())) {
          completed += 1;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: options.concurrency }, (_, vu) => virtualUser(vu)));
  clearTimeout(timer);
  return {
    windowStartedAt,
    windowEndedAt: new Date(windowStartedAt.getTime() + options.durationMs),
    windowSeconds: options.durationMs / 1_000,
    completed,
    attempts,
    latencies,
    newLatencies,
    replayLatencies,
    outcomes,
    failedAttempts,
    retries,
  };
}
