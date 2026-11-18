import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DriverException, IsolationLevel, LockWaitTimeoutException } from '@mikro-orm/core';
import { Migration } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { buildOrmOptions } from '../../../src/infrastructure/persistence/mikro-orm.config';
import { createTestDatabase, type TestDatabase } from '../../support/database';

/** Migration descartável, só para provar o mecanismo (lista explícita, up/down) sob o Bun. */
class CreateProbeTable extends Migration {
  override up(): void {
    this.addSql('create table probe (id int primary key, amount numeric(20,2) not null)');
  }

  override down(): void {
    this.addSql('drop table probe');
  }
}

const PROBE_MIGRATION = 'Migration00000000000001_probe';

let database: TestDatabase;
let orm: MikroORM;

beforeAll(async () => {
  database = await createTestDatabase('postgres');
  orm = await MikroORM.init(
    buildOrmOptions(
      { url: database.url, poolMax: 5, connectTimeoutMs: 2000 },
      createLogger({ level: 'silent' }),
      { migrationsList: [{ name: PROBE_MIGRATION, class: CreateProbeTable }] },
    ),
  );
});

afterAll(async () => {
  await orm?.close();
  await database?.drop();
});

async function tableExists(name: string): Promise<boolean> {
  const [row] = await orm.em
    .fork()
    .execute<{ exists: boolean }[]>('select to_regclass(?) is not null as exists', [name]);
  return row?.exists === true;
}

describe('PostgreSQL via MikroORM', () => {
  test('numeric chega como string exata, sem passar por number', async () => {
    const [row] = await orm.em
      .fork()
      .execute(
        "select '99999999999999999.99'::numeric(20,2) as big, 0.1::numeric(20,2) + 0.2::numeric(20,2) as sum",
      );

    expect(row).toEqual({ big: '99999999999999999.99', sum: '0.30' });
  });

  test('migrations sobem e descem pela lista explícita', async () => {
    expect((await orm.migrator.getPending()).map((migration) => migration.name)).toEqual([PROBE_MIGRATION]);

    await orm.migrator.up();
    expect(await tableExists('probe')).toBe(true);

    await orm.migrator.down();
    expect(await tableExists('probe')).toBe(false);

    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toEqual([]);
  });

  test('lock timeout chega como DriverException com SQLSTATE 55P03, não como LockWaitTimeoutException', async () => {
    await orm.em.fork().execute("insert into probe (id, amount) values (1, '10.00')");

    let releaseHolder = (): void => {};
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let signalLocked = (): void => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute('select id from probe where id = 1 for update');
      signalLocked();
      await holderMayFinish;
    });
    await locked;

    const contender = orm.em.fork().transactional(
      async (em) => {
        await em.execute("set local lock_timeout = '200ms'");
        await em.execute('select id from probe where id = 1 for update');
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
    const error = await contender.then(
      () => undefined,
      (failure: unknown) => failure,
    );

    releaseHolder();
    await holder;

    expect(error).toBeInstanceOf(DriverException);
    expect(error).not.toBeInstanceOf(LockWaitTimeoutException);
    expect((error as DriverException).code).toBe('55P03');
  });
});
