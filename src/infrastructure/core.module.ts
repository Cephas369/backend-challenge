import { type BeforeApplicationShutdown, type DynamicModule, Inject, Module } from '@nestjs/common';
import type { AppConfig } from './config/config';
import { LifecycleState } from './lifecycle';
import type { AppLogger } from './observability/logger';
import { APP_CONFIG, LOGGER } from './tokens';

/** Disponibiliza configuração, logger e estado do ciclo de vida para toda a aplicação. */
@Module({})
export class CoreModule implements BeforeApplicationShutdown {
  constructor(
    @Inject(LOGGER) private readonly logger: AppLogger,
    private readonly lifecycle: LifecycleState,
  ) {}

  static forRoot(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
        { provide: LifecycleState, useValue: new LifecycleState() },
      ],
      exports: [APP_CONFIG, LOGGER, LifecycleState],
    };
  }

  beforeApplicationShutdown(signal?: string): void {
    // o readiness passa a responder 503 enquanto consumer e workers terminam o que estão fazendo
    this.lifecycle.markShuttingDown();
    this.logger.info({ signal }, 'shutdown started');
  }
}
