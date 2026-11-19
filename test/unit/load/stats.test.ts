import { describe, expect, test } from 'bun:test';
import {
  centsOf,
  counterDeltas,
  formatCents,
  histogramEstimate,
  parsePrometheus,
  percentile,
  summarize,
} from '../../load/stats';

describe('estatística do teste de carga', () => {
  test('percentil nearest-rank sobre as amostras completas', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);

    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 99)).toBe(99);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
  });

  test('resumo ordena as amostras antes de calcular', () => {
    expect(summarize([30, 10, 20])).toEqual({ count: 3, mean: 20, p50: 20, p95: 30, p99: 30, max: 30 });
  });

  test('lê o formato texto do Prometheus e soma o crescimento entre instâncias', () => {
    const before = [
      parsePrometheus('# HELP x\nwagering_lock_conflicts_total{type="lock-timeout"} 1\nother_metric 5\n'),
      parsePrometheus(''),
    ];
    const after = [
      parsePrometheus('wagering_lock_conflicts_total{type="lock-timeout"} 4\nother_metric 9\n'),
      parsePrometheus('wagering_lock_conflicts_total{type="lock-timeout"} 2\nwagering_retries_total 0\n'),
    ];

    expect([...counterDeltas(before, after, ['wagering_'])]).toEqual([
      ['wagering_lock_conflicts_total{type="lock-timeout"}', 5],
    ]);
  });

  test('percentis estimados pelo histograma, interpolando dentro do bucket', () => {
    const metric = 'wagering_processing_duration_seconds';
    const reading = (fast: number, slow: number, sum: number) =>
      parsePrometheus(
        [
          `${metric}_bucket{le="0.005",source="http"} ${fast}`,
          `${metric}_bucket{le="0.01",source="http"} ${fast + slow}`,
          `${metric}_bucket{le="+Inf",source="http"} ${fast + slow}`,
          `${metric}_sum{source="http"} ${sum}`,
          `${metric}_count{source="http"} ${fast + slow}`,
          `${metric}_bucket{le="0.005",source="sqs"} ${fast * 7}`,
        ].join('\n'),
      );
    // entre as leituras: 10 observações até 5 ms e 10 entre 5 e 10 ms, somando 150 ms
    const before = [reading(4, 0, 0.01)];
    const after = [reading(14, 10, 0.16)];

    const estimate = histogramEstimate(before, after, metric, 'source="http"');

    expect(estimate.count).toBe(20);
    expect(estimate.mean).toBeCloseTo(7.5);
    expect(estimate.p50).toBeCloseTo(5);
    expect(estimate.p95).toBeCloseTo(9.5);
  });

  test('centavos ida e volta, sem passar por number', () => {
    expect(centsOf('100000.05')).toBe(10_000_005n);
    expect(formatCents(10_000_005n)).toBe('100000.05');
    expect(formatCents(-250n)).toBe('-2.50');
    expect(() => centsOf('1.5')).toThrow();
  });
});
