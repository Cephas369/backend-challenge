import { SQL } from 'bun';
import { requiredEnv, uniqueSuffix } from './unique';

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
