import path from 'node:path';
import type { Subprocess } from 'bun';
import { waitFor } from './wait';

export const PROJECT_ROOT = path.resolve(import.meta.dir, '../..');

export type LogLine = Record<string, unknown> & { msg?: string };

/** Processo real da aplicação, com os logs JSON do stdout coletados linha a linha. */
export interface AppProcess {
  readonly process: Subprocess<'ignore', 'pipe', 'pipe'>;
  readonly logs: LogLine[];
  waitForLog(
    predicate: (line: LogLine) => boolean,
    description: string,
    timeoutMs?: number,
  ): Promise<LogLine>;
  stderr(): Promise<string>;
}

export function spawnApp(environment: Record<string, string>): AppProcess {
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...environment },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const logs: LogLine[] = [];
  void collectJsonLines(child.stdout, logs);

  return {
    process: child,
    logs,
    waitForLog: (predicate, description, timeoutMs = 10_000) =>
      waitFor(() => logs.find(predicate), { description, timeoutMs }),
    stderr: () => new Response(child.stderr).text(),
  };
}

async function collectJsonLines(stream: ReadableStream<Uint8Array>, into: LogLine[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line.startsWith('{')) {
        into.push(JSON.parse(line) as LogLine);
      }
      newline = buffered.indexOf('\n');
    }
  }
}
