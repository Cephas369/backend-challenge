import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MigratedDatabase } from '../support/database';
import { PROJECT_ROOT } from '../support/process';
import { parsePrometheus } from './stats';

/** O mínimo do processo filho que o teste de carga usa. */
interface ChildProcess {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/** Uma instância real da aplicação (`bun src/main.ts`), com os logs indo para arquivo. */
export interface Instance {
  readonly name: string;
  readonly baseUrl: string;
  readonly process: ChildProcess;
}

/**
 * Sobe a instância numa porta livre e espera o readiness. Os logs (JSON, nível info, como em produção)
 * vão direto para arquivo: o cliente de carga não gasta CPU lendo-os.
 */
export async function startInstance(
  name: string,
  environment: Record<string, string>,
  logDir: string,
): Promise<Instance> {
  const port = freePort();
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...environment, PORT: String(port) },
    stdin: 'ignore',
    stdout: Bun.file(path.join(logDir, `${name}.log`)),
    stderr: Bun.file(path.join(logDir, `${name}.stderr.log`)),
  });
  const instance: Instance = { name, baseUrl: `http://127.0.0.1:${port}`, process: child };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} saiu com código ${child.exitCode}; veja os logs em ${logDir}`);
    }
    try {
      if ((await fetch(`${instance.baseUrl}/health/ready`)).ok) {
        return instance;
      }
    } catch {
      // ainda subindo
    }
    await Bun.sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`${name} não ficou pronta em 30 s; veja os logs em ${logDir}`);
}

/** SIGTERM (shutdown gracioso); se não sair a tempo, SIGKILL. */
export async function stopInstance(instance: Instance): Promise<void> {
  instance.process.kill('SIGTERM');
  const exited = await Promise.race([
    instance.process.exited.then(() => true),
    Bun.sleep(25_000).then(() => false),
  ]);
  if (!exited) {
    instance.process.kill('SIGKILL');
    await instance.process.exited;
  }
}

function freePort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) {
    throw new Error('não foi possível reservar uma porta');
  }
  return port;
}

export async function scrapeMetrics(instance: Instance): Promise<Map<string, number>> {
  const response = await fetch(`${instance.baseUrl}/metrics`);
  return parsePrometheus(await response.text());
}

const CLOCK_TICKS = (() => {
  try {
    return Number(Bun.spawnSync(['getconf', 'CLK_TCK']).stdout.toString().trim()) || 100;
  } catch {
    return 100;
  }
})();

/** CPU (usuário + sistema) já consumida pelo processo, em segundos. Só em Linux (`/proc`). */
export async function cpuSecondsOf(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // depois de "(nome) ", os campos começam no 3 (state); utime e stime são o 14 e o 15
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS;
  } catch {
    return undefined;
  }
}

/** Amostra única de CPU dos containers (via `docker stats`); vazia se o Docker não responder. */
export async function sampleContainerCpu(nameFragments: readonly string[]): Promise<Record<string, string>> {
  try {
    const child = Bun.spawn(['docker', 'stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(child.stdout).text();
    await child.exited;
    const sample: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const [name, cpu] = line.split('\t');
      if (name !== undefined && cpu !== undefined && nameFragments.some((part) => name.includes(part))) {
        sample[name] = cpu;
      }
    }
    return sample;
  } catch {
    return {};
  }
}

/** O que precisa constar no relatório para o número ter contexto. */
export async function captureEnvironment(db: MigratedDatabase): Promise<Record<string, string>> {
  const [settings] = await db.orm.em.fork().execute<
    {
      server_version: string;
      shared_buffers: string;
      synchronous_commit: string;
      max_connections: string;
    }[]
  >(
    `select current_setting('server_version') as server_version,
            current_setting('shared_buffers') as shared_buffers,
            current_setting('synchronous_commit') as synchronous_commit,
            current_setting('max_connections') as max_connections`,
  );
  const compose = await readFile(path.join(PROJECT_ROOT, 'docker-compose.yml'), 'utf8');
  const git = (args: string[]) =>
    Bun.spawnSync(['git', ...args], { cwd: PROJECT_ROOT })
      .stdout.toString()
      .trim();
  const cpus = os.cpus();
  return {
    CPU: `${cpus[0]?.model.trim() ?? '?'} (${cpus.length} threads lógicas)`,
    Memória: `${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`,
    Sistema: `${os.type()} ${os.release()}`,
    Bun: Bun.version,
    PostgreSQL: settings
      ? `${settings.server_version} em Docker (shared_buffers=${settings.shared_buffers}, ` +
        `synchronous_commit=${settings.synchronous_commit}, max_connections=${settings.max_connections})`
      : '?',
    // o endpoint vem do ambiente: com o padrão (4566) é a MiniStack do compose
    SQS: (process.env.SQS_ENDPOINT ?? '').includes(':4566')
      ? `MiniStack ${/ministackorg\/ministack:([\w.]+)/.exec(compose)?.[1] ?? '?'} em Docker (${process.env.SQS_ENDPOINT})`
      : `${process.env.SQS_ENDPOINT}`,
    Commit: `${git(['rev-parse', '--short', 'HEAD'])}${git(['status', '--porcelain']) === '' ? '' : ' (com alterações locais)'}`,
  };
}
