import { type BeforeApplicationShutdown, type DynamicModule, Inject, Module } from '@nestjs/common';
import type { AppConfig } from './config/config';
import type { AppLogger } from './observability/logger';
import { APP_CONFIG, LOGGER } from './tokens';

/** Disponibiliza configuração e logger para toda a aplicação. */
@Module({})
export class CoreModule implements BeforeApplicationShutdown {
  constructor(@Inject(LOGGER) private readonly logger: AppLogger) {}

  static forRoot(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: LOGGER, useValue: logger },
      ],
      exports: [APP_CONFIG, LOGGER],
    };
  }

  beforeApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'shutdown started');
  }
}
