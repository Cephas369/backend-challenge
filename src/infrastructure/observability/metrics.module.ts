import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type DynamicModule, Module } from '@nestjs/common';
import type { UnitOfWork } from '../../application/ports/persistence';
import type { AppConfig } from '../config/config';
import { APP_CONFIG, SQS_CLIENT, UNIT_OF_WORK } from '../tokens';
import { PrometheusMetrics } from './metrics';

const SCRAPE_TIMEOUT_MS = 1_000;

@Module({})
export class MetricsModule {
  static forRoot(): DynamicModule {
    return {
      module: MetricsModule,
      global: true,
      providers: [
        {
          provide: PrometheusMetrics,
          inject: [UNIT_OF_WORK, SQS_CLIENT, APP_CONFIG],
          useFactory: (unitOfWork: UnitOfWork, sqs: SQSClient, config: AppConfig) => {
            const metrics = new PrometheusMetrics();
            metrics.trackOutbox(() => unitOfWork.readOnly(({ outbox }) => outbox.pendingStats(new Date())));
            metrics.trackDeadLetterQueue(async () => {
              const signal = AbortSignal.timeout(SCRAPE_TIMEOUT_MS);
              const { QueueUrl } = await sqs.send(
                new GetQueueUrlCommand({ QueueName: config.sqs.wagerDlq }),
                {
                  abortSignal: signal,
                },
              );
              const { Attributes } = await sqs.send(
                new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }),
                { abortSignal: signal },
              );
              return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
            });
            return metrics;
          },
        },
      ],
      exports: [PrometheusMetrics],
    };
  }
}
