import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';
import type {
  ConcurrencyConflictKind,
  DuplicateLayer,
  WageringMetrics,
} from '../../application/ports/metrics';

export type TransactionSource = 'http' | 'sqs' | 'worker';

/**
 * Métricas Prometheus (seção 12): transações por status, duplicatas, retries, DLQ, conflitos de
 * lock, outbox lag e latência. Gauges que dependem de banco ou broker são lidos na hora do scrape.
 */
export class PrometheusMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações decididas, por tipo, status e origem (replays incluídos)',
    labelNames: ['kind', 'status', 'source', 'replay'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Repetições reconhecidas, por camada (pré-checagem, idempotency key sob lock, inbox)',
    labelNames: ['layer'] as const,
    registers: [this.registry],
  });

  private readonly conflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de concorrência: lock timeout e conflito de versão/serialização',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas agendadas, por componente e motivo',
    labelNames: ['component', 'reason'] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wagering_dead_letter_messages_total',
    help: 'Mensagens movidas para a DLQ, por motivo',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly published = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos publicados a partir da outbox',
    registers: [this.registry],
  });

  private readonly reconciliationMismatches = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Reconciliações em que o saldo não bateu com o ledger',
    registers: [this.registry],
  });

  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de uma transação, por origem',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(options: { readonly defaultMetrics?: boolean } = {}) {
    if (options.defaultMetrics ?? true) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  // porta da aplicação

  duplicateDetected(layer: DuplicateLayer): void {
    this.duplicates.inc({ layer });
  }

  concurrencyConflict(kind: ConcurrencyConflictKind): void {
    this.conflicts.inc({ type: kind });
  }

  retryScheduled(component: string, reason: string, count = 1): void {
    if (count > 0) {
      this.retries.inc({ component, reason }, count);
    }
  }

  // bordas (HTTP, consumer, workers)

  transactionDecided(kind: string, status: string, source: TransactionSource, replay: boolean): void {
    this.transactions.inc({ kind, status, source, replay: String(replay) });
  }

  observeProcessing(source: TransactionSource, seconds: number): void {
    this.duration.observe({ source }, seconds);
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  outboxPublished(count: number): void {
    if (count > 0) {
      this.published.inc(count);
    }
  }

  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  /**
   * Outbox lag e pendências, lidos do banco a cada scrape. Cada gauge coleta por conta própria:
   * o registro coleta as métricas em paralelo, então um não pode depender do outro.
   */
  trackOutbox(read: () => Promise<{ readonly pending: number; readonly oldestAgeMs: number }>): void {
    new Gauge({
      name: 'wagering_outbox_pending_messages',
      help: 'Eventos ainda não publicados',
      registers: [this.registry],
      async collect() {
        const stats = await read().catch(() => undefined);
        if (stats !== undefined) {
          this.set(stats.pending);
        }
      },
    });
    new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo da outbox',
      registers: [this.registry],
      async collect() {
        const stats = await read().catch(() => undefined);
        if (stats !== undefined) {
          this.set(stats.oldestAgeMs / 1_000);
        }
      },
    });
  }

  /** Mensagens paradas na DLQ, lidas do broker a cada scrape. */
  trackDeadLetterQueue(read: () => Promise<number>): void {
    new Gauge({
      name: 'wagering_dead_letter_queue_depth',
      help: 'Mensagens aguardando na DLQ (aproximado, como o SQS informa)',
      registers: [this.registry],
      async collect() {
        const depth = await read().catch(() => undefined);
        if (depth !== undefined) {
          this.set(depth);
        }
      },
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
