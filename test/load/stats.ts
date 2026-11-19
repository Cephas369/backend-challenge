/**
 * Estatística do teste de carga. Os percentis saem das amostras completas (nearest-rank), sem
 * histograma aproximado; as métricas do servidor vêm do formato texto do Prometheus.
 */

export interface LatencySummary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Percentil `p` (de 0 a 100) pelo método nearest-rank; `sorted` precisa estar em ordem crescente. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? Number.NaN;
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    mean: sorted.length === 0 ? Number.NaN : total / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? Number.NaN,
  };
}

/** Valor de cada série (`nome{rótulos}`). Comentários, linhas vazias e valores não numéricos são ignorados. */
export function parsePrometheus(text: string): Map<string, number> {
  const series = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const separator = line.lastIndexOf(' ');
    const value = Number(line.slice(separator + 1));
    if (separator > 0 && !Number.isNaN(value)) {
      series.set(line.slice(0, separator), value);
    }
  }
  return series;
}

/**
 * Quanto cada série que começa com um dos prefixos cresceu entre duas leituras, somado entre as
 * instâncias (`before[i]` e `after[i]` são da mesma instância). Séries que não mudaram ficam de fora.
 */
export function counterDeltas(
  before: readonly ReadonlyMap<string, number>[],
  after: readonly ReadonlyMap<string, number>[],
  prefixes: readonly string[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const [index, series] of after.entries()) {
    for (const [name, value] of series) {
      if (!prefixes.some((prefix) => name.startsWith(prefix))) {
        continue;
      }
      const delta = value - (before[index]?.get(name) ?? 0);
      if (delta !== 0) {
        deltas.set(name, (deltas.get(name) ?? 0) + delta);
      }
    }
  }
  return deltas;
}

export interface HistogramEstimate {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/**
 * Percentis (em ms) estimados pelo crescimento dos buckets cumulativos de um histograma do Prometheus
 * entre duas leituras, somado entre as instâncias: interpolação linear dentro do bucket, como faz o
 * `histogram_quantile`. A precisão é a dos buckets.
 */
export function histogramEstimate(
  before: readonly ReadonlyMap<string, number>[],
  after: readonly ReadonlyMap<string, number>[],
  metric: string,
  label: string,
): HistogramEstimate {
  const cumulative = new Map<number, number>();
  let sum = 0;
  let count = 0;
  for (const [index, series] of after.entries()) {
    for (const [name, value] of series) {
      if (!name.startsWith(metric) || !name.includes(label)) {
        continue;
      }
      const delta = value - (before[index]?.get(name) ?? 0);
      if (name.startsWith(`${metric}_bucket{`)) {
        const le = Number(/le="([^"]+)"/.exec(name)?.[1]);
        cumulative.set(le, (cumulative.get(le) ?? 0) + delta);
      } else if (name.startsWith(`${metric}_sum`)) {
        sum += delta;
      } else if (name.startsWith(`${metric}_count`)) {
        count += delta;
      }
    }
  }
  const buckets = [...cumulative].sort(([a], [b]) => a - b);
  const total = buckets.at(-1)?.[1] ?? 0;
  const quantile = (q: number): number => {
    if (total <= 0) {
      return Number.NaN;
    }
    const rank = q * total;
    let lower = 0;
    let below = 0;
    for (const [le, atOrBelow] of buckets) {
      if (atOrBelow >= rank) {
        if (!Number.isFinite(le)) {
          return lower * 1_000; // além do maior bucket finito: só se sabe o limite inferior
        }
        const inBucket = atOrBelow - below;
        return (inBucket <= 0 ? le : lower + (le - lower) * ((rank - below) / inBucket)) * 1_000;
      }
      lower = le;
      below = atOrBelow;
    }
    return Number.NaN;
  };
  return {
    count,
    mean: count === 0 ? Number.NaN : (sum / count) * 1_000,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
  };
}

/** Formata centavos como "12.34". */
export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

/** Converte "12.34" (escala fixa de 2, como o banco devolve) em centavos. */
export function centsOf(amount: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(amount);
  if (match === null) {
    throw new Error(`valor fora da escala fixa: ${amount}`);
  }
  return BigInt(`${match[1]}${match[2]}`);
}
