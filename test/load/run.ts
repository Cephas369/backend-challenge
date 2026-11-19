import '../setup';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet } from '../../src/application/wallets/wallet-queries';
import { Money } from '../../src/domain/money/money';
import { systemClock, uuidV7Generator } from '../../src/infrastructure/runtime';
import { createMigratedDatabase, type MigratedDatabase } from '../support/database';
import { uuid } from '../support/persistence';
import { PROJECT_ROOT } from '../support/process';
import { createTestQueues, createTestSqsClient, type TestQueues, uniqueQueueTopology } from '../support/sqs';
import { type BrokerProbe, startBrokerProbe } from './broker-probe';
import { startEventSink } from './event-sink';
import {
  captureEnvironment,
  cpuSecondsOf,
  type Instance,
  sampleContainerCpu,
  scrapeMetrics,
  startInstance,
  stopInstance,
} from './harness';
import { type ClosedLoopResult, runClosedLoop } from './http-driver';
import {
  type Check,
  type HttpScenario,
  type LoadReport,
  type OutboxLag,
  type PublicationBucket,
  renderReport,
  type SqsScenario,
  type Usage,
} from './report';
import { runSqsScenario } from './sqs-load';
import { centsOf, counterDeltas, formatCents, histogramEstimate, summarize } from './stats';
import { type WalletRef, Workload, type WorkloadOptions } from './workload';

/**
 * Teste de carga (`bun run test:load`). Sobe instâncias reais da aplicação sobre um banco exclusivo,
 * roda os cenários, confere as invariantes e grava relatório e logs em `load-results/`. Cada cenário
 * (e cada nível da hot wallet) usa filas novas e instâncias novas: a MiniStack fica mais lenta conforme
 * a fila FIFO acumula histórico de deduplicação, e um cenário não deve herdar o estado do outro.
 * Requer a infraestrutura local (`bun run infra:up`). Metodologia em docs/TESTE-DE-CARGA.md.
 */
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    scenarios: { type: 'string', default: 'distributed,hot,sqs' },
    instances: { type: 'string', default: '3' },
    wallets: { type: 'string', default: '500' },
    concurrency: { type: 'string', default: '64' },
    duration: { type: 'string', default: '30' },
    warmup: { type: 'string', default: '5' },
    'hot-levels': { type: 'string', default: '1,8,32,64' },
    'hot-duration': { type: 'string', default: '10' },
    'sqs-messages': { type: 'string', default: '3000' },
    'sqs-wallets': { type: 'string', default: '100' },
    'report-dir': { type: 'string', default: 'load-results' },
  },
});

const scenarios = new Set((args.scenarios ?? '').split(','));
const options = {
  instances: Number(args.instances),
  wallets: scenarios.has('distributed') ? Number(args.wallets) : 0,
  concurrency: Number(args.concurrency),
  durationMs: Number(args.duration) * 1_000,
  warmupMs: Number(args.warmup) * 1_000,
  hotLevels: scenarios.has('hot') ? (args['hot-levels'] ?? '').split(',').map(Number) : [],
  hotDurationMs: Number(args['hot-duration']) * 1_000,
  sqsMessages: scenarios.has('sqs') ? Number(args['sqs-messages']) : 0,
  sqsWallets: scenarios.has('sqs') ? Number(args['sqs-wallets']) : 0,
};

const COUNTERS = [
  'wagering_lock_conflicts_total',
  'wagering_retries_total',
  'wagering_duplicates_detected_total',
  'wagering_dead_letter_messages_total',
  'wagering_outbox_published_total',
];
const PROCESSING_HISTOGRAM = 'wagering_processing_duration_seconds';
const INITIAL_BALANCE = '1000000.00';
const MAX_RETRIES = 5;
const EVENT_SINK_WORKERS = 6;

// Mesma configuração padrão do compose, explícita para o relatório ser reproduzível.
const APP_SETTINGS: Record<string, string> = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  APP_ROLES: 'api,consumer,outbox,pending-ref',
  DATABASE_POOL_MAX: '10',
  DATABASE_LOCK_TIMEOUT_MS: '2000',
  DATABASE_STATEMENT_TIMEOUT_MS: '5000',
  SQS_RECEIVE_BATCH_SIZE: '10',
  SQS_WAIT_TIME_SECONDS: '20',
  OUTBOX_BATCH_SIZE: '10',
  OUTBOX_IDLE_DELAY_MS: '500',
};

const log = (message: string) =>
  console.error(`[carga ${new Date().toISOString().slice(11, 19)}] ${message}`);

interface Snapshot {
  readonly metrics: Map<string, number>[];
  readonly cpu: (number | undefined)[];
  readonly client: NodeJS.CpuUsage;
  readonly at: number;
}

async function snapshot(instances: readonly Instance[]): Promise<Snapshot> {
  const [metrics, cpu] = await Promise.all([
    Promise.all(instances.map(scrapeMetrics)),
    Promise.all(instances.map((instance) => cpuSecondsOf(instance.process.pid))),
  ]);
  return { metrics, cpu, client: process.cpuUsage(), at: performance.now() };
}

function usageBetween(before: Snapshot, after: Snapshot, containerCpu: Record<string, string>): Usage {
  const seconds = (after.at - before.at) / 1_000;
  const clientSeconds =
    (after.client.user - before.client.user + after.client.system - before.client.system) / 1e6;
  const processing = (source: 'http' | 'sqs') =>
    histogramEstimate(before.metrics, after.metrics, PROCESSING_HISTOGRAM, `source="${source}"`);
  return {
    counters: Object.fromEntries(counterDeltas(before.metrics, after.metrics, COUNTERS)),
    processing: { http: processing('http'), sqs: processing('sqs') },
    instanceCpuPercent: after.cpu.map((value, index) => {
      const start = before.cpu[index];
      return value === undefined || start === undefined ? undefined : ((value - start) / seconds) * 100;
    }),
    clientCpuPercent: (clientSeconds / seconds) * 100,
    containerCpu,
  };
}

/** Uma leitura por segundo da fila de eventos ainda não publicados. */
function startOutboxSampler(db: MigratedDatabase) {
  const samples: { at: number; pending: number; oldestMs: number }[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const [row] = await db.orm.em.fork().execute<{ pending: number; oldest_ms: string | null }[]>(
        `select count(*)::int as pending,
                extract(epoch from (clock_timestamp() - min(occurred_at))) * 1000 as oldest_ms
           from outbox_messages where published_at is null`,
      );
      samples.push({ at: Date.now(), pending: row?.pending ?? 0, oldestMs: Number(row?.oldest_ms ?? 0) });
      await Bun.sleep(1_000);
    }
  })();
  return {
    peakBetween(from: Date, to: Date) {
      const window = samples.filter((sample) => sample.at >= from.getTime() && sample.at <= to.getTime());
      return {
        peakPending: Math.max(0, ...window.map((sample) => sample.pending)),
        peakOldestMs: Math.max(0, ...window.map((sample) => sample.oldestMs)),
      };
    },
    async stop() {
      running = false;
      await loop;
    },
  };
}
type OutboxSampler = ReturnType<typeof startOutboxSampler>;

/** Lag de publicação (`published_at - occurred_at`) dos eventos gerados na janela. */
async function outboxLag(
  db: MigratedDatabase,
  sampler: OutboxSampler,
  from: Date,
  to: Date,
): Promise<OutboxLag> {
  const [row] = await db.orm.em
    .fork()
    .execute<
      { events: number; p50: number | null; p95: number | null; p99: number | null; max: string | null }[]
    >(
      `select count(*)::int as events,
            percentile_cont(0.5) within group (order by lag_ms) as p50,
            percentile_cont(0.95) within group (order by lag_ms) as p95,
            percentile_cont(0.99) within group (order by lag_ms) as p99,
            max(lag_ms) as max
       from (select extract(epoch from (published_at - occurred_at)) * 1000 as lag_ms
               from outbox_messages
              where occurred_at >= ? and occurred_at < ? and published_at is not null) lags`,
      [from, to],
    );
  return {
    events: row?.events ?? 0,
    p50: Number(row?.p50 ?? Number.NaN),
    p95: Number(row?.p95 ?? Number.NaN),
    p99: Number(row?.p99 ?? Number.NaN),
    max: Number(row?.max ?? Number.NaN),
    ...sampler.peakBetween(from, to),
  };
}

async function countOutbox(db: MigratedDatabase, where: string): Promise<number> {
  const [row] = await db.orm.em
    .fork()
    .execute<{ total: number }[]>(`select count(*)::int as total from outbox_messages where ${where}`);
  return row?.total ?? 0;
}

async function waitOutboxDrained(db: MigratedDatabase, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await countOutbox(db, 'published_at is null')) === 0) {
      return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

/** Wallets criadas direto pelo use case (com o evento de abertura na outbox), antes das instâncias. */
async function createWallets(db: MigratedDatabase, count: number): Promise<WalletRef[]> {
  const createWallet = new CreateWallet(db.unitOfWork, systemClock, uuidV7Generator);
  const wallets: WalletRef[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < count; index = next++) {
      const playerId = uuid();
      const wallet = await createWallet.execute({
        playerId,
        initialBalance: Money.from({ amount: INITIAL_BALANCE, currency: 'BRL' }),
        correlationId: uuid(),
      });
      wallets.push({ id: wallet.id, playerId, initialCents: centsOf(INITIAL_BALANCE) });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return wallets;
}

interface Cluster {
  readonly db: MigratedDatabase;
  readonly sqs: SQSClient;
  readonly queues: TestQueues;
  readonly instances: readonly Instance[];
  readonly sampler: OutboxSampler;
  readonly probe: BrokerProbe;
}

/**
 * Eventos publicados por segundo desde o início da janela (todos, inclusive os do aquecimento), em
 * faixas de 30 s até a outbox esvaziar, ao lado da latência mediana da sonda do broker na faixa.
 */
async function publicationTimeline(
  db: MigratedDatabase,
  from: Date,
  probe: BrokerProbe,
): Promise<PublicationBucket[]> {
  const rows = await db.orm.em.fork().execute<{ second: number; published: number }[]>(
    `select floor(extract(epoch from (published_at - ?::timestamptz)))::int as second,
            count(*)::int as published
       from outbox_messages where published_at >= ?
      group by 1 order by 1`,
    [from, from],
  );
  const lastSecond = rows.at(-1)?.second ?? 0;
  const buckets: PublicationBucket[] = [];
  for (let start = 0; start <= lastSecond; start += 30) {
    const end = Math.min(start + 30, lastSecond + 1);
    const published = rows
      .filter((row) => row.second >= start && row.second < end)
      .reduce((sum, row) => sum + row.published, 0);
    const probes = probe.samples
      .filter(
        (sample) => sample.at >= from.getTime() + start * 1_000 && sample.at < from.getTime() + end * 1_000,
      )
      .map((sample) => sample.ms);
    buckets.push({
      fromSecond: start,
      toSecond: end,
      perSecond: published / (end - start),
      probeMs: summarize(probes).p50,
    });
  }
  return buckets;
}

/** O que cada cluster deixa para as invariantes do fim. */
interface ClusterOutcome {
  readonly label: string;
  readonly drained: boolean;
  readonly published: number;
  readonly delivered: { readonly distinct: number; readonly deliveries: number };
  readonly deadLetters: number;
}

interface Run {
  readonly db: MigratedDatabase;
  readonly sqs: SQSClient;
  readonly sampler: OutboxSampler;
  readonly reportDir: string;
  readonly outcomes: ClusterOutcome[];
}

/**
 * Filas novas, instâncias novas e um consumidor de eventos; espera a outbox esvaziar antes de medir e
 * de novo no fim, e só então derruba tudo.
 */
async function withCluster<T>(run: Run, label: string, work: (cluster: Cluster) => Promise<T>): Promise<T> {
  const queues = await createTestQueues(run.sqs, uniqueQueueTopology(`load-${label}`));
  const settings = {
    ...APP_SETTINGS,
    DATABASE_URL: run.db.database.url,
    SQS_WAGER_QUEUE: queues.topology.wagerQueue,
    SQS_WAGER_DLQ: queues.topology.wagerDlq,
    SQS_EVENTS_QUEUE: queues.topology.eventsQueue,
  };
  const instances: Instance[] = [];
  const sink = startEventSink(run.sqs, queues.urls.eventsQueueUrl, EVENT_SINK_WORKERS);
  const probe = startBrokerProbe(run.sqs, queues.urls.eventsQueueUrl);
  // antes de subir as instâncias: ninguém está publicando (o cluster anterior já saiu)
  const publishedBefore = await countOutbox(run.db, 'published_at is not null');
  try {
    instances.push(
      ...(await Promise.all(
        Array.from({ length: options.instances }, (_, index) =>
          startInstance(`${label}-instance-${index + 1}`, settings, run.reportDir),
        ),
      )),
    );
    if (!(await waitOutboxDrained(run.db, 300_000))) {
      log(`aviso: a outbox não drenou antes de ${label}`);
    }
    const result = await work({ db: run.db, sqs: run.sqs, queues, instances, sampler: run.sampler, probe });
    const drained = await waitOutboxDrained(run.db, 300_000);
    const published = (await countOutbox(run.db, 'published_at is not null')) - publishedBefore;
    await sink.waitFor(published, 120_000);
    const dlq = await run.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queues.urls.wagerDlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    run.outcomes.push({
      label,
      drained,
      published,
      delivered: sink.stats(),
      deadLetters: Number(dlq.Attributes?.ApproximateNumberOfMessages ?? '0'),
    });
    return result;
  } finally {
    await Promise.all(instances.map(stopInstance));
    await probe.stop();
    await sink.stop();
    await queues.drop();
  }
}

/** Cenário HTTP: contadores, CPU e outbox medidos só na janela (depois do aquecimento). */
async function httpScenario(
  cluster: Cluster,
  title: string,
  workload: Workload,
  load: { concurrency: number; warmupMs: number; durationMs: number },
): Promise<HttpScenario> {
  let before: Promise<Snapshot> | undefined;
  let containers: Promise<Record<string, string>> | undefined;
  const loop: ClosedLoopResult = await runClosedLoop({
    targets: cluster.instances.map((instance) => instance.baseUrl),
    ...load,
    maxRetries: MAX_RETRIES,
    workload,
    onWindowStart: () => {
      before = snapshot(cluster.instances);
      setTimeout(() => {
        containers = sampleContainerCpu(['wagering-postgres', 'wagering-sqs']);
      }, load.durationMs / 2);
    },
  });
  const after = await snapshot(cluster.instances);
  const usage = usageBetween(await (before ?? snapshot(cluster.instances)), after, (await containers) ?? {});
  // o lag definitivo só existe depois que a outbox drena
  if (!(await waitOutboxDrained(cluster.db, 300_000))) {
    log(`aviso: a outbox não drenou depois de "${title}"`);
  }
  const outbox = await outboxLag(cluster.db, cluster.sampler, loop.windowStartedAt, loop.windowEndedAt);
  const publication = await publicationTimeline(cluster.db, loop.windowStartedAt, cluster.probe);
  return { title, concurrency: load.concurrency, loop, usage, outbox, publication };
}

function workloadFactory(registry: { workload: Workload; wallets: readonly WalletRef[] }[]) {
  return (overrides: Pick<WorkloadOptions, 'name' | 'wallets'> & Partial<WorkloadOptions>) => {
    const workload = new Workload({
      providerId: 'provider-load',
      mix: { BET: 60, WIN: 25, LOSS: 10, REFUND: 5 },
      duplicateRate: 0.05,
      betCents: [100, 5_000],
      winCents: [100, 10_000],
      ...overrides,
    });
    registry.push({ workload, wallets: overrides.wallets });
    return workload;
  };
}

async function main(): Promise<void> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = path.resolve(PROJECT_ROOT, args['report-dir'] ?? 'load-results', runId);
  await mkdir(reportDir, { recursive: true });

  log('preparando o banco exclusivo');
  const db = await createMigratedDatabase('load');
  const sqs = createTestSqsClient();
  const sampler = startOutboxSampler(db);
  const run: Run = { db, sqs, sampler, reportDir, outcomes: [] };
  let failed = true;

  try {
    const environment = await captureEnvironment(db);
    const walletsNeeded = options.wallets + options.hotLevels.length + options.sqsWallets;
    log(`criando ${walletsNeeded} wallets`);
    const allWallets = await createWallets(db, walletsNeeded);
    const distributedWallets = allWallets.slice(0, options.wallets);
    const hotWallets = allWallets.slice(options.wallets, options.wallets + options.hotLevels.length);
    const sqsWallets = allWallets.slice(options.wallets + options.hotLevels.length);
    const workloads: { workload: Workload; wallets: readonly WalletRef[] }[] = [];
    const workloadFor = workloadFactory(workloads);

    let distributed: HttpScenario | undefined;
    if (scenarios.has('distributed')) {
      log(
        `cenário 1: ${options.concurrency} usuários virtuais em ${options.wallets} wallets por ${options.durationMs / 1_000} s`,
      );
      distributed = await withCluster(run, 'dist', (cluster) =>
        httpScenario(
          cluster,
          `Wallets distribuídas: ${options.concurrency} usuários virtuais sobre ${options.wallets} wallets`,
          workloadFor({ name: 'dist', wallets: distributedWallets }),
          { concurrency: options.concurrency, warmupMs: options.warmupMs, durationMs: options.durationMs },
        ),
      );
    }

    const hot: HttpScenario[] = [];
    for (const [index, concurrency] of options.hotLevels.entries()) {
      const wallet = hotWallets[index];
      if (wallet === undefined) {
        continue;
      }
      log(`cenário 2: hot wallet com concorrência ${concurrency}`);
      hot.push(
        await withCluster(run, `hot${concurrency}`, (cluster) =>
          httpScenario(
            cluster,
            `Hot wallet, concorrência ${concurrency}`,
            workloadFor({
              name: `hot${concurrency}`,
              wallets: [wallet],
              mix: { BET: 50, WIN: 50 },
              duplicateRate: 0,
              betCents: [100, 100],
              winCents: [100, 100],
            }),
            { concurrency, warmupMs: 2_000, durationMs: options.hotDurationMs },
          ),
        ),
      );
    }

    let sqsScenario: SqsScenario | undefined;
    if (scenarios.has('sqs')) {
      log(`cenário 3: ${options.sqsMessages} mensagens na fila para ${options.sqsWallets} wallets`);
      sqsScenario = await withCluster(run, 'sqs', async (cluster) => {
        const before = await snapshot(cluster.instances);
        const containers = sampleContainerCpu(['wagering-postgres', 'wagering-sqs']);
        const result = await runSqsScenario({
          sqs,
          queueUrl: cluster.queues.urls.wagerQueueUrl,
          db,
          wallets: sqsWallets,
          messages: options.sqsMessages,
          duplicateRate: 0.02,
          senders: 8,
          timeoutMs: 300_000,
        });
        const usage = usageBetween(before, await snapshot(cluster.instances), await containers);
        await waitOutboxDrained(db, 300_000);
        return {
          result,
          usage,
          outbox: await outboxLag(db, sampler, result.windowStartedAt, result.windowEndedAt),
        };
      });
    }

    log('conferindo invariantes');
    const checks = await verify(db, {
      allWallets,
      workloads,
      sqsWallets,
      sqsScenario,
      outcomes: run.outcomes,
    });

    const report: LoadReport = {
      runId,
      environment,
      parameters: {
        Instâncias: `${options.instances} processos (todos os papéis), pool de ${APP_SETTINGS.DATABASE_POOL_MAX} conexões cada`,
        'Configuração da aplicação': Object.entries(APP_SETTINGS)
          .map(([key, value]) => `${key}=${value}`)
          .join(', '),
        ...(distributed === undefined
          ? {}
          : {
              'Cenário 1': `${options.concurrency} usuários virtuais, ${options.warmupMs / 1_000} s de aquecimento + ${options.durationMs / 1_000} s medidos; BET 60%, WIN 25%, LOSS 10%, REFUND 5%; 5% de reenvios`,
            }),
        ...(hot.length === 0
          ? {}
          : {
              'Cenário 2': `concorrência ${options.hotLevels.join(', ')}; 2 s de aquecimento + ${options.hotDurationMs / 1_000} s medidos por nível; BET e WIN de 1.00`,
            }),
        ...(sqsScenario === undefined
          ? {}
          : {
              'Cenário 3': `${options.sqsMessages} mensagens em ${options.sqsWallets} wallets (grupos FIFO), 2% duplicadas, 8 envios de lote simultâneos`,
            }),
        Isolamento:
          'cada cenário e cada nível da hot wallet usa filas e instâncias novas e começa com a outbox vazia',
        'Consumidor de eventos': `${EVENT_SINK_WORKERS} laços de receive (10) + delete em lote na fila de eventos, no papel do downstream`,
        'Retentativa do cliente': `até ${MAX_RETRIES} reenvios com a mesma key depois do Retry-After (503 ou queda de conexão)`,
      },
      ...(distributed === undefined ? {} : { distributed }),
      hot,
      ...(sqsScenario === undefined ? {} : { sqs: sqsScenario }),
      checks,
    };
    const markdown = renderReport(report);
    await writeFile(path.join(reportDir, 'report.md'), markdown);
    // no JSON, as amostras brutas de latência viram resumo (são dezenas de milhares de números)
    await writeFile(
      path.join(reportDir, 'results.json'),
      JSON.stringify(
        report,
        (key, value) =>
          value instanceof Map
            ? Object.fromEntries(value)
            : ['latencies', 'newLatencies', 'replayLatencies'].includes(key)
              ? summarize(value as number[])
              : value,
        2,
      ),
    );
    console.log(markdown);
    log(`relatório e logs em ${path.relative(PROJECT_ROOT, reportDir)}`);
    failed = checks.some((check) => !check.passed);
  } finally {
    await sampler.stop();
    sqs.destroy();
    await db.close();
  }
  process.exitCode = failed ? 1 : 0;
}

/** O teste só vale se, depois da carga, o dinheiro fechar exatamente. */
async function verify(
  db: MigratedDatabase,
  input: {
    allWallets: readonly WalletRef[];
    workloads: readonly { workload: Workload; wallets: readonly WalletRef[] }[];
    sqsWallets: readonly WalletRef[];
    sqsScenario: SqsScenario | undefined;
    outcomes: readonly ClusterOutcome[];
  },
): Promise<Check[]> {
  const checks: Check[] = [];
  const reconcile = new ReconcileWallet(db.unitOfWork);
  const inconsistent: string[] = [];
  for (const wallet of input.allWallets) {
    if (!(await reconcile.execute(wallet.id)).consistent) {
      inconsistent.push(wallet.id);
    }
  }
  checks.push({
    description: `todas as ${input.allWallets.length} wallets reconciliam (saldo = créditos − débitos do ledger)`,
    passed: inconsistent.length === 0,
    ...(inconsistent.length === 0 ? {} : { detail: `divergentes: ${inconsistent.join(', ')}` }),
  });

  const balances = new Map(
    (
      await db.orm.em
        .fork()
        .execute<{ id: string; balance: string }[]>('select id, balance_amount::text as balance from wallets')
    ).map((row) => [row.id, centsOf(row.balance)]),
  );
  const mismatched: string[] = [];
  const expectBalance = (wallet: WalletRef, expected: bigint) => {
    const actual = balances.get(wallet.id);
    if (actual !== expected) {
      mismatched.push(
        `${wallet.id}: banco ${actual === undefined ? '?' : formatCents(actual)}, esperado ${formatCents(expected)}`,
      );
    }
  };
  for (const { workload, wallets } of input.workloads) {
    for (const wallet of wallets) {
      expectBalance(wallet, workload.expectedCents(wallet));
    }
  }
  if (input.sqsScenario !== undefined) {
    for (const wallet of input.sqsWallets) {
      expectBalance(wallet, input.sqsScenario.result.expectedCents(wallet));
    }
  }
  checks.push({
    description: 'o saldo final de cada wallet é exatamente o que o cliente calculou pelas respostas',
    passed: mismatched.length === 0,
    ...(mismatched.length === 0 ? {} : { detail: mismatched.slice(0, 5).join('; ') }),
  });

  const anomalies = input.workloads.flatMap(({ workload }) => workload.anomalies);
  checks.push({
    description: 'todo reenvio com a mesma key devolveu o replay do original, sem 4xx inesperado',
    passed: anomalies.length === 0,
    ...(anomalies.length === 0 ? {} : { detail: anomalies.slice(0, 5).join('; ') }),
  });
  const unresolved = input.workloads.reduce((sum, { workload }) => sum + workload.unresolved, 0);
  checks.push({
    description: `nenhuma operação ficou sem desfecho depois de ${MAX_RETRIES} reenvios`,
    passed: unresolved === 0,
    ...(unresolved === 0 ? {} : { detail: `${unresolved} operações` }),
  });
  if (input.sqsScenario !== undefined) {
    const statuses = input.sqsScenario.result.statuses;
    checks.push({
      description: 'todas as mensagens da fila foram decididas, uma única vez cada',
      passed: statuses.PROCESSED === input.sqsScenario.result.messages,
      detail: JSON.stringify(statuses),
    });
  }
  const deadLetters = input.outcomes.reduce((sum, outcome) => sum + outcome.deadLetters, 0);
  checks.push({ description: 'DLQ vazia', passed: deadLetters === 0, detail: `${deadLetters} mensagens` });
  checks.push({
    description: 'outbox drenada ao fim de cada cenário',
    passed: input.outcomes.every((outcome) => outcome.drained),
  });
  const undelivered = input.outcomes.filter((outcome) => outcome.delivered.distinct < outcome.published);
  const published = input.outcomes.reduce((sum, outcome) => sum + outcome.published, 0);
  const deliveries = input.outcomes.reduce((sum, outcome) => sum + outcome.delivered.deliveries, 0);
  checks.push({
    description: 'cada evento publicado chegou ao consumidor da fila de eventos',
    passed: undelivered.length === 0,
    detail:
      undelivered.length === 0
        ? `${published} eventos, em ${deliveries} entregas`
        : undelivered
            .map((outcome) => `${outcome.label}: ${outcome.delivered.distinct} de ${outcome.published}`)
            .join('; '),
  });
  return checks;
}

await main();
