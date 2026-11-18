import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '../../../infrastructure/config/config';
import type { AppLogger } from '../../../infrastructure/observability/logger';
import { APP_CONFIG, LOGGER, MIKRO_ORM, SQS_CLIENT } from '../../../infrastructure/tokens';

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly checks: { readonly database: DependencyStatus; readonly sqs: DependencyStatus };
}

/** Readiness = PostgreSQL e SQS alcançáveis (seção 9). Cada checagem tem timeout próprio. */
@Injectable()
export class ReadinessService {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const [database, sqs] = await Promise.all([
      // `orm.checkConnection()` não serve aqui: no MikroORM 7 o pool é preguiçoso e o método
      // responde "Connection not established" até a primeira query. Um `select 1` real conecta e mede.
      this.probe('database', async (signal) => {
        await this.orm.em.fork({ signal }).execute('select 1');
      }),
      this.probe('sqs', async (signal) => {
        await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueue }), {
          abortSignal: signal,
        });
      }),
    ]);
    return {
      status: database === 'up' && sqs === 'up' ? 'ok' : 'unavailable',
      checks: { database, sqs },
    };
  }

  private async probe(
    dependency: string,
    check: (signal: AbortSignal) => Promise<void>,
  ): Promise<DependencyStatus> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`${dependency} não respondeu em ${this.config.health.timeoutMs} ms`)),
      this.config.health.timeoutMs,
    );
    try {
      await Promise.race([check(controller.signal), rejectWhenAborted(controller.signal)]);
      return 'up';
    } catch (error) {
      this.logger.warn({ dependency, err: error }, 'readiness check failed');
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
