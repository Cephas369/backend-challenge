import 'reflect-metadata';
import { createApp, listeningPort } from './bootstrap';
import { loadConfig } from './infrastructure/config/config';
import { createLogger } from './infrastructure/observability/logger';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.log.level });
  try {
    const app = await createApp(config, logger);
    app.enableShutdownHooks();
    await app.listen(config.http.port);
    logger.info({ port: listeningPort(app) }, 'http server listening');
  } catch (error) {
    logger.fatal({ err: error }, 'failed to start');
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // só chega aqui se a configuração for inválida, antes de existir logger
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
