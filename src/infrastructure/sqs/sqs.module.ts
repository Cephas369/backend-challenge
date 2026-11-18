import { SQSClient } from '@aws-sdk/client-sqs';
import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { AppConfig } from '../config/config';
import type { AppLogger } from '../observability/logger';
import { APP_CONFIG, LOGGER, SQS_CLIENT } from '../tokens';
import { createSqsClient } from './sqs.client';

@Module({})
export class SqsModule implements OnApplicationShutdown {
  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  static forRoot(): DynamicModule {
    return {
      module: SqsModule,
      global: true,
      providers: [
        {
          provide: SQS_CLIENT,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig) => createSqsClient(config.sqs),
        },
      ],
      exports: [SQS_CLIENT],
    };
  }

  onApplicationShutdown(): void {
    this.client.destroy();
    this.logger.info('sqs client closed');
  }
}
