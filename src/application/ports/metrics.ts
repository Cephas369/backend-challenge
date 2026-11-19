/** Onde uma repetição foi reconhecida (do mais barato para o mais caro). */
export type DuplicateLayer = 'pre-check' | 'idempotency-key' | 'inbox';

export type ConcurrencyConflictKind = 'lock-timeout' | 'concurrency-conflict';

/** O que só o use case enxerga e a observabilidade precisa contar. */
export interface WageringMetrics {
  duplicateDetected(layer: DuplicateLayer): void;
  concurrencyConflict(kind: ConcurrencyConflictKind): void;
  retryScheduled(component: string, reason: string): void;
}

export const noopMetrics: WageringMetrics = {
  duplicateDetected: () => {},
  concurrencyConflict: () => {},
  retryScheduled: () => {},
};
