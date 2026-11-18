import type { MigrationObject } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import type { DatabaseConfig } from '../config/config';
import type { AppLogger } from '../observability/logger';
import { migrationsList } from './migrations';

export interface OrmOptionsOverrides {
  /** Permite que testes rodem migrations próprias contra um banco descartável. */
  readonly migrationsList?: MigrationObject[];
}

export function buildOrmOptions(
  config: DatabaseConfig,
  logger: AppLogger,
  overrides: OrmOptionsOverrides = {},
): Options {
  return defineConfig({
    clientUrl: config.url,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    // o banco é criado pela infraestrutura (compose/testes), nunca pela aplicação
    ensureDatabase: false,
    // todo acesso ao EntityManager passa por um fork explícito por unidade de trabalho
    allowGlobalContext: false,
    forceUtcTimezone: true,
    pool: { min: 0, max: config.poolMax },
    driverOptions: { connectionTimeoutMillis: config.connectTimeoutMs },
    logger: (message) => logger.warn({ component: 'mikro-orm' }, message),
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: overrides.migrationsList ?? migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
