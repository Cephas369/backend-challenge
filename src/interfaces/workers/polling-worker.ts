import { ExponentialBackoff } from '../../domain/shared/exponential-backoff';
import type { AppLogger } from '../../infrastructure/observability/logger';
import { Sleeper } from './sleeper';

export interface PollingWorkerOptions {
  /** Pausa quando a rodada não encontrou trabalho. */
  readonly idleDelayMs: number;
  /** Pausa crescente depois de rodadas que falharam (banco ou broker fora). */
  readonly errorBackoff?: ExponentialBackoff;
}

/**
 * Laço de um worker em segundo plano: roda `tick` em sequência, descansa quando não há trabalho e
 * recua com backoff quando falha. `stop()` interrompe a espera na hora e aguarda a rodada em curso.
 */
export class PollingWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly sleeper = new Sleeper();
  private readonly errorBackoff: ExponentialBackoff;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly options: PollingWorkerOptions,
    private readonly logger: AppLogger,
  ) {
    this.errorBackoff =
      options.errorBackoff ??
      new ExponentialBackoff({ initialDelayMs: 500, maxDelayMs: 30_000, jitter: 0.2 });
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
    this.logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.sleeper.interrupt();
    await this.loop;
    this.logger.info({ worker: this.name }, 'worker stopped');
  }

  private async run(): Promise<void> {
    let consecutiveFailures = 0;
    while (this.running) {
      try {
        const handled = await this.tick();
        consecutiveFailures = 0;
        if (handled === 0) {
          await this.sleeper.sleep(this.options.idleDelayMs);
        }
      } catch (error) {
        consecutiveFailures += 1;
        this.logger.warn({ worker: this.name, err: error, consecutiveFailures }, 'worker round failed');
        await this.sleeper.sleep(this.errorBackoff.delayFor(consecutiveFailures));
      }
    }
  }
}
