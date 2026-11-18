import { MikroORM } from '@mikro-orm/postgresql';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import type { AppLogger } from '../observability/logger';
import { APP_CONFIG, LOGGER, MIKRO_ORM } from '../tokens';
import { buildOrmOptions } from './mikro-orm.config';

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
      ],
      exports: [MIKRO_ORM],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.logger.info('database pool closed');
  }
}
