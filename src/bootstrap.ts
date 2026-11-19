import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule, type AppOptions } from './app.module';
import type { AppConfig } from './infrastructure/config/config';
import type { AppLogger } from './infrastructure/observability/logger';
import { NestPinoLogger } from './infrastructure/observability/nest-logger';
import { correlationIdMiddleware } from './interfaces/http/correlation-id.middleware';
import { ProblemDetailsFilter } from './interfaces/http/problem-details';

/** Monta a aplicação; usado pelo `main.ts` e pelos testes que sobem o app em processo. */
export async function createApp(
  config: AppConfig,
  logger: AppLogger,
  options: AppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, logger, options), {
    logger: new NestPinoLogger(logger.child({ component: 'nest' })),
    abortOnError: false,
  });
  app.disable('x-powered-by');
  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new ProblemDetailsFilter(logger.child({ component: 'http' })));
  return app;
}

export function listeningPort(app: NestExpressApplication): number | undefined {
  const address: unknown = app.getHttpServer().address();
  return typeof address === 'object' && address !== null && 'port' in address
    ? Number(address.port)
    : undefined;
}
