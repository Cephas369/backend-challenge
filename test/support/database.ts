import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import type { DatabaseConfig } from '../../src/infrastructure/config/config';
import { createLogger } from '../../src/infrastructure/observability/logger';
import { buildOrmOptions } from '../../src/infrastructure/persistence/mikro-orm.config';
import {
  MikroOrmUnitOfWork,
  type UnitOfWorkOptions,
} from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { requiredEnv, uniqueSuffix } from './unique';

export function testDatabaseConfig(url: string, overrides: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return {
    url,
    poolMax: 10,
    connectTimeoutMs: 2000,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    ...overrides,
  };
}

export interface MigratedDatabase {
  readonly database: TestDatabase;
  readonly orm: MikroORM;
  readonly unitOfWork: MikroOrmUnitOfWork;
  /** Outro UnitOfWork no mesmo banco, com opções próprias (ex.: lock timeout curto). */
  unitOfWorkWith(options: Partial<UnitOfWorkOptions>): MikroOrmUnitOfWork;
  close(): Promise<void>;
}

/** Banco descartável com o schema real aplicado pelas migrations da aplicação. */
export async function createMigratedDatabase(label: string): Promise<MigratedDatabase> {
  const database = await createTestDatabase(label);
  const config = testDatabaseConfig(database.url);
  const orm = await MikroORM.init(buildOrmOptions(config, createLogger({ level: 'silent' })));
  await orm.migrator.up();
  const unitOfWorkWith = (options: Partial<UnitOfWorkOptions>) =>
    new MikroOrmUnitOfWork(orm, {
      lockTimeoutMs: config.lockTimeoutMs,
      statementTimeoutMs: config.statementTimeoutMs,
      ...options,
    });
  return {
    database,
    orm,
    unitOfWork: unitOfWorkWith({}),
    unitOfWorkWith,
    close: async () => {
      await orm.close();
      await database.drop();
    },
  };
}

export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * Cada suíte de integração ganha um banco próprio, criado vazio e removido no fim.
 * Isso isola as suítes e permite testar migrations a partir do zero.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const name = `wagering_test_${label.replace(/[^a-z0-9_]/g, '_')}_${uniqueSuffix()}`;
  await withAdminConnection((sql) => sql.unsafe(`create database "${name}"`));
  const url = new URL(requiredEnv('DATABASE_URL'));
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    drop: () => withAdminConnection((sql) => sql.unsafe(`drop database if exists "${name}" with (force)`)),
  };
}

async function withAdminConnection(run: (sql: SQL) => PromiseLike<unknown>): Promise<void> {
  const adminUrl = new URL(requiredEnv('DATABASE_URL'));
  const sql = new SQL(adminUrl.toString());
  try {
    await run(sql);
  } catch (error) {
    throw new Error(
      `PostgreSQL de teste indisponível em ${adminUrl.host} — rode \`bun run infra:up\` antes dos testes de integração`,
      { cause: error },
    );
  } finally {
    await sql.close();
  }
}
