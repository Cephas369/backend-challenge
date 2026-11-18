import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import type { AppLogger } from '../observability/logger';
import { APP_CONFIG, LOGGER, MIKRO_ORM, UNIT_OF_WORK } from '../tokens';
import { buildOrmOptions } from './mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Module({})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(
    @Inject(MIKRO_ORM) private readonly orm: MikroORM,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  static forRoot(): DynamicModule {
    return {
      module: PersistenceModule,
      global: true,
      providers: [
        {
          provide: MIKRO_ORM,
          inject: [APP_CONFIG, LOGGER],
          useFactory: (config: AppConfig, logger: AppLogger) =>
            MikroORM.init(buildOrmOptions(config.database, logger)),
        },
        {
          provide: UNIT_OF_WORK,
          inject: [MIKRO_ORM, APP_CONFIG],
          useFactory: (orm: MikroORM, config: AppConfig) =>
            new MikroOrmUnitOfWork(orm, {
              lockTimeoutMs: config.database.lockTimeoutMs,
              statementTimeoutMs: config.database.statementTimeoutMs,
            }),
        },
      ],
      exports: [MIKRO_ORM, UNIT_OF_WORK],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.logger.info('database pool closed');
  }
}
