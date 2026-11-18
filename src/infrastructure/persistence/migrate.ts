import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/config';
import { createLogger } from '../observability/logger';
import { buildOrmOptions } from './mikro-orm.config';

/**
 * Executor de migrations: `up` aplica as pendentes, `down` reverte a última, `pending` lista.
 * Roda como script (`bun run db:migrate`) e como serviço one-shot no compose.
 */
const command = process.argv[2];
if (command !== 'up' && command !== 'down' && command !== 'pending') {
  console.error('uso: bun src/infrastructure/persistence/migrate.ts <up|down|pending>');
  process.exit(2);
}

const config = loadConfig(process.env);
const logger = createLogger({ level: config.log.level }).child({ component: 'migrator' });
const orm = await MikroORM.init(buildOrmOptions(config.database, logger));

try {
  if (command === 'up') {
    const applied = await orm.migrator.up();
    logger.info({ applied: applied.map((migration) => migration.name) }, 'migrations applied');
  } else if (command === 'down') {
    const reverted = await orm.migrator.down();
    logger.info({ reverted: reverted.map((migration) => migration.name) }, 'migration reverted');
  } else {
    const pending = await orm.migrator.getPending();
    logger.info({ pending: pending.map((migration) => migration.name) }, 'pending migrations');
  }
} catch (error) {
  logger.fatal({ err: error }, `migrate ${command} failed`);
  process.exitCode = 1;
} finally {
  await orm.close();
}
