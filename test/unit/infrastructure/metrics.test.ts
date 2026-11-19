import { describe, expect, test } from 'bun:test';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/metrics';

function line(text: string, prefix: string): string | undefined {
  return text.split('\n').find((candidate) => candidate.startsWith(prefix));
}

describe('PrometheusMetrics', () => {
  test('expõe as métricas exigidas na seção 12', async () => {
    const metrics = new PrometheusMetrics({ defaultMetrics: false });
    metrics.trackOutbox(async () => ({ pending: 3, oldestAgeMs: 1_500 }));
    metrics.trackDeadLetterQueue(async () => 2);

    metrics.transactionDecided('BET', 'PROCESSED', 'http', false);
    metrics.transactionDecided('BET', 'REJECTED', 'sqs', false);
    metrics.duplicateDetected('inbox');
    metrics.concurrencyConflict('lock-timeout');
    metrics.retryScheduled('consumer', 'TRANSIENT_INFRASTRUCTURE:LOCK_TIMEOUT');
    metrics.deadLettered('INVALID_MESSAGE');
    metrics.observeProcessing('http', 0.02);
    metrics.outboxPublished(5);
    metrics.reconciliationMismatch();
    const text = await metrics.render();

    expect(
      line(text, 'wagering_transactions_total{kind="BET",status="PROCESSED",source="http",replay="false"}'),
    ).toEndWith(' 1');
    expect(line(text, 'wagering_transactions_total{kind="BET",status="REJECTED",source="sqs"')).toBeDefined();
    expect(line(text, 'wagering_duplicates_detected_total{layer="inbox"}')).toEndWith(' 1');
    expect(line(text, 'wagering_lock_conflicts_total{type="lock-timeout"}')).toEndWith(' 1');
    expect(line(text, 'wagering_retries_total{component="consumer"')).toEndWith(' 1');
    expect(line(text, 'wagering_dead_letter_messages_total{reason="INVALID_MESSAGE"}')).toEndWith(' 1');
    expect(line(text, 'wagering_processing_duration_seconds_count{source="http"}')).toEndWith(' 1');
    expect(line(text, 'wagering_outbox_published_total')).toEndWith(' 5');
    expect(line(text, 'wagering_reconciliation_mismatches_total')).toEndWith(' 1');
    expect(line(text, 'wagering_outbox_lag_seconds ')).toBe('wagering_outbox_lag_seconds 1.5');
    expect(line(text, 'wagering_outbox_pending_messages ')).toBe('wagering_outbox_pending_messages 3');
    expect(line(text, 'wagering_dead_letter_queue_depth ')).toBe('wagering_dead_letter_queue_depth 2');
  });

  test('um gauge que falha ao ler não derruba o scrape', async () => {
    const metrics = new PrometheusMetrics({ defaultMetrics: false });
    metrics.trackDeadLetterQueue(async () => {
      throw new Error('SQS fora');
    });

    expect(await metrics.render()).toContain('wagering_dead_letter_queue_depth');
  });

  test('cada instância tem o próprio registro (várias apps no mesmo processo de teste)', async () => {
    const first = new PrometheusMetrics({ defaultMetrics: false });
    const second = new PrometheusMetrics({ defaultMetrics: false });
    first.outboxPublished(1);

    expect(line(await second.render(), 'wagering_outbox_published_total')).toEndWith(' 0');
  });
});
