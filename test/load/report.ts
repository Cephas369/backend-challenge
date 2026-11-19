import type { ClosedLoopResult } from './http-driver';
import type { SqsScenarioResult } from './sqs-load';
import { type HistogramEstimate, type LatencySummary, summarize } from './stats';

/** Recursos consumidos durante a janela de um cenário. */
export interface Usage {
  /** Crescimento dos contadores do servidor, somado entre as instâncias. */
  readonly counters: Readonly<Record<string, number>>;
  /** Duração do processamento no servidor (use case), estimada pelo histograma, por origem. */
  readonly processing: Readonly<Record<'http' | 'sqs', HistogramEstimate>>;
  /** CPU de cada instância, em % de um núcleo. */
  readonly instanceCpuPercent: readonly (number | undefined)[];
  readonly clientCpuPercent: number;
  /** Amostra do `docker stats` no meio da janela (% de um núcleo). */
  readonly containerCpu: Readonly<Record<string, string>>;
}

export interface OutboxLag {
  readonly events: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** Maior fila de eventos pendentes vista pela amostragem (1 por segundo) durante a janela. */
  readonly peakPending: number;
  readonly peakOldestMs: number;
}

/** Publicação da outbox numa faixa de tempo contada do início da janela de medição. */
export interface PublicationBucket {
  readonly fromSecond: number;
  readonly toSecond: number;
  readonly perSecond: number;
  /** Mediana da sonda do broker na faixa (`SendMessageBatch` de 10 na fila de eventos). */
  readonly probeMs: number;
}

export interface HttpScenario {
  readonly title: string;
  readonly concurrency: number;
  readonly loop: ClosedLoopResult;
  readonly usage: Usage;
  readonly outbox: OutboxLag;
  readonly publication: readonly PublicationBucket[];
}

export interface SqsScenario {
  readonly result: SqsScenarioResult;
  readonly usage: Usage;
  readonly outbox: OutboxLag;
}

export interface Check {
  readonly description: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface LoadReport {
  readonly runId: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly parameters: Readonly<Record<string, string>>;
  readonly distributed?: HttpScenario;
  readonly hot: readonly HttpScenario[];
  readonly sqs?: SqsScenario;
  readonly checks: readonly Check[];
}

const ms = (value: number) => (Number.isFinite(value) ? value.toFixed(1) : '—');
const latency = (summary: LatencySummary) =>
  `${ms(summary.p50)} / ${ms(summary.p95)} / ${ms(summary.p99)} / ${ms(summary.max)}`;
const estimate = (histogram: HistogramEstimate) =>
  `${ms(histogram.p50)} / ${ms(histogram.p95)} / ${ms(histogram.p99)} (média ${ms(histogram.mean)})`;
const percent = (part: number, total: number) =>
  total === 0 ? '0,00%' : `${((part / total) * 100).toFixed(2).replace('.', ',')}%`;
const integer = (value: number) => Math.round(value).toLocaleString('pt-BR');
const throughput = (loop: ClosedLoopResult) => integer(loop.completed / loop.windowSeconds);

/** Encurta `wagering_lock_conflicts_total{type="lock-timeout"}` para `lock_conflicts{type="lock-timeout"}`. */
function counterName(series: string): string {
  return series.replace(/^wagering_/, '').replace('_total', '');
}

function counters(usage: Usage, fragment: string): string {
  const entries = Object.entries(usage.counters).filter(([series]) => series.includes(fragment));
  return entries.length === 0
    ? '0'
    : entries.map(([series, value]) => `${counterName(series)}: ${integer(value)}`).join('<br>');
}

function cpu(usage: Usage): string {
  const instances = usage.instanceCpuPercent
    .map((value) => (value === undefined ? '?' : `${value.toFixed(0)}%`))
    .join(', ');
  const containers = Object.entries(usage.containerCpu)
    .map(([name, value]) => `${name.replace(/^wagering-|-1$/g, '')} ${value}`)
    .join(', ');
  return `instâncias ${instances} · cliente ${usage.clientCpuPercent.toFixed(0)}%${containers === '' ? '' : ` · ${containers}`}`;
}

function outboxLine(outbox: OutboxLag): string {
  return (
    `${integer(outbox.events)} eventos; ${ms(outbox.p50)} / ${ms(outbox.p95)} / ${ms(outbox.p99)} / ` +
    `${ms(outbox.max)} ms; pico de ${integer(outbox.peakPending)} pendentes (mais antigo: ${ms(outbox.peakOldestMs)} ms)`
  );
}

function outcomes(loop: ClosedLoopResult): string {
  return [...loop.outcomes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([label, count]) => `${label}: ${integer(count)}`)
    .join('<br>');
}

function distributedSection(scenario: HttpScenario): string[] {
  const loop = scenario.loop;
  return [
    `## 1. ${scenario.title}`,
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Throughput | ${throughput(loop)} operações/s (${integer(loop.completed)} em ${loop.windowSeconds} s) |`,
    `| Latência no cliente, todas as tentativas | ${latency(summarize(loop.latencies))} |`,
    `| Latência no cliente, operações novas | ${latency(summarize(loop.newLatencies))} |`,
    `| Latência no cliente, replays | ${latency(summarize(loop.replayLatencies))} |`,
    `| Processamento no servidor (histograma) | ${estimate(scenario.usage.processing.http)} |`,
    `| Taxa de erro (5xx ou sem resposta) | ${percent(loop.failedAttempts, loop.attempts)} (${integer(loop.failedAttempts)} de ${integer(loop.attempts)} tentativas) |`,
    `| Reenvios por 503 | ${integer(loop.retries)} |`,
    `| Respostas | ${outcomes(loop)} |`,
    `| Conflitos de lock | ${counters(scenario.usage, 'lock_conflicts')} |`,
    `| Retentativas no servidor | ${counters(scenario.usage, 'retries')} |`,
    `| Duplicatas detectadas | ${counters(scenario.usage, 'duplicates_detected')} |`,
    `| Outbox lag | ${outboxLine(scenario.outbox)} |`,
    `| Publicação da outbox, por faixa desde o início da janela | ${publicationLine(scenario)} |`,
    `| CPU (% de um núcleo) | ${cpu(scenario.usage)} |`,
    '',
  ];
}

function publicationLine(scenario: HttpScenario): string {
  const last = scenario.publication.at(-1);
  const drain =
    last === undefined
      ? ''
      : `<br>a outbox esvaziou ${Math.max(0, last.toSecond - scenario.loop.windowSeconds)} s depois do fim da carga`;
  return (
    scenario.publication
      .map(
        (bucket) =>
          `${bucket.fromSecond}–${bucket.toSecond} s: ${integer(bucket.perSecond)} eventos/s (sonda do broker ${ms(bucket.probeMs)} ms)`,
      )
      .join('<br>') + drain
  );
}

function hotSection(steps: readonly HttpScenario[]): string[] {
  return [
    '## 2. Hot wallet: todas as operações na mesma wallet',
    '',
    '| Concorrência | Throughput (op/s) | Latência no cliente | Processamento no servidor | Erros | Reenvios 503 | Conflitos de lock | CPU |',
    '|---|---|---|---|---|---|---|---|',
    ...steps.map(
      (step) =>
        `| ${step.concurrency} | ${throughput(step.loop)} | ${latency(summarize(step.loop.latencies))} | ` +
        `${estimate(step.usage.processing.http)} | ${percent(step.loop.failedAttempts, step.loop.attempts)} | ` +
        `${integer(step.loop.retries)} | ${counters(step.usage, 'lock_conflicts')} | ${cpu(step.usage)} |`,
    ),
    '',
    'Outbox lag por nível:',
    '',
    ...steps.map((step) => `- concorrência ${step.concurrency}: ${outboxLine(step.outbox)}`),
    '',
  ];
}

function sqsSection(sqs: SqsScenario): string[] {
  return [
    '## 3. Ingestão pela fila',
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Mensagens | ${integer(sqs.result.messages)} únicas, mais ${integer(sqs.result.duplicatesSent)} duplicatas com o mesmo \`messageId\` |`,
    `| Envio | ${sqs.result.sendSeconds.toFixed(2)} s |`,
    `| Throughput | ${integer(sqs.result.throughput)} mensagens/s (tudo decidido em ${sqs.result.drainSeconds.toFixed(1)} s) |`,
    `| Envio → início do processamento | ${latency(sqs.result.sentToProcessing)} |`,
    `| Processamento no servidor (histograma) | ${estimate(sqs.usage.processing.sqs)} |`,
    `| Desfechos | ${Object.entries(sqs.result.statuses)
      .map(([status, total]) => `${status}: ${integer(total)}`)
      .join(', ')} |`,
    `| Duplicatas detectadas | ${counters(sqs.usage, 'duplicates_detected')} |`,
    `| Retentativas no servidor | ${counters(sqs.usage, 'retries')} |`,
    `| Outbox lag | ${outboxLine(sqs.outbox)} |`,
    `| CPU (% de um núcleo) | ${cpu(sqs.usage)} |`,
    '',
  ];
}

export function renderReport(report: LoadReport): string {
  return [
    `# Teste de carga ${report.runId}`,
    '',
    'Latências em ms, no formato p50 / p95 / p99 / máx. Metodologia e análise em `docs/TESTE-DE-CARGA.md`.',
    '',
    '## Ambiente',
    '',
    '| Item | Valor |',
    '|---|---|',
    ...Object.entries(report.environment).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    '## Parâmetros',
    '',
    '| Parâmetro | Valor |',
    '|---|---|',
    ...Object.entries(report.parameters).map(([key, value]) => `| ${key} | ${value} |`),
    '',
    ...(report.distributed === undefined ? [] : distributedSection(report.distributed)),
    ...(report.hot.length === 0 ? [] : hotSection(report.hot)),
    ...(report.sqs === undefined ? [] : sqsSection(report.sqs)),
    '## Invariantes',
    '',
    ...report.checks.map(
      (check) =>
        `- ${check.passed ? '✅' : '❌'} ${check.description}${check.detail === undefined ? '' : ` (${check.detail})`}`,
    ),
    '',
  ].join('\n');
}
