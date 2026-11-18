import type { Logger, LoggerNamespace } from '@mikro-orm/core';
import type { AppLogger } from '../observability/logger';

/** Namespaces que carregariam SQL e parâmetros (valores financeiros): nunca são logados. */
const SILENT_NAMESPACES: ReadonlySet<string> = new Set(['query', 'query-params', 'slow-query']);

/** Encaminha os logs do MikroORM para o pino, com o nível correto e sem queries. */
export class PinoMikroOrmLogger implements Logger {
  constructor(private readonly logger: AppLogger) {}

  log(namespace: string, message: string): void {
    this.logger.debug({ component: 'mikro-orm', namespace }, message);
  }

  warn(namespace: string, message: string): void {
    this.logger.warn({ component: 'mikro-orm', namespace }, message);
  }

  error(namespace: string, message: string): void {
    this.logger.error({ component: 'mikro-orm', namespace }, message);
  }

  logQuery(): void {}

  setDebugMode(): void {}

  isEnabled(namespace: LoggerNamespace): boolean {
    return !SILENT_NAMESPACES.has(namespace);
  }
}
