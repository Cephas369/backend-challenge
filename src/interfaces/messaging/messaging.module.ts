import { SQSClient } from '@aws-sdk/client-sqs';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PublishOutboxBatch } from '../../application/messaging/publish-outbox';
import type { UnitOfWork } from '../../application/ports/persistence';
import type { Clock, IdGenerator } from '../../application/ports/runtime';
import { ReprocessPendingReferences } from '../../application/wagering/reprocess-pending-references';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { WagerSettlement } from '../../domain/wagering/wager-settlement';
import type { AppConfig } from '../../infrastructure/config/config';
import type { AppLogger } from '../../infrastructure/observability/logger';
import { QueueUrls } from '../../infrastructure/sqs/queue-urls';
import { SqsEventPublisher } from '../../infrastructure/sqs/sqs-event-publisher';
import {
  APP_CONFIG,
  CLOCK,
  ID_GENERATOR,
  LOGGER,
  SQS_CLIENT,
  UNIT_OF_WORK,
} from '../../infrastructure/tokens';
import { PollingWorker } from '../workers/polling-worker';
import { WagerTransactionConsumer } from './wager-transaction-consumer';

export const OUTBOX_WORKER = Symbol('OUTBOX_WORKER');
export const PENDING_REFERENCE_WORKER = Symbol('PENDING_REFERENCE_WORKER');

/**
 * Consumer SQS, publisher da outbox e worker de referências pendentes. Cada um só liga se a
 * instância tiver o papel correspondente (`APP_ROLES`); no shutdown, todos param antes do banco fechar.
 */
@Module({})
export class MessagingModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly consumer: WagerTransactionConsumer,
    @Inject(OUTBOX_WORKER) private readonly outboxWorker: PollingWorker,
    @Inject(PENDING_REFERENCE_WORKER) private readonly pendingReferenceWorker: PollingWorker,
  ) {}

  static forRoot(): DynamicModule {
    return {
      module: MessagingModule,
      providers: [
        {
          provide: QueueUrls,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) => new QueueUrls(client),
        },
        {
          provide: SqsEventPublisher,
          inject: [SQS_CLIENT, QueueUrls, APP_CONFIG],
          useFactory: (client: SQSClient, queues: QueueUrls, config: AppConfig) =>
            new SqsEventPublisher(
              client,
              queues,
              config.sqs.eventsQueue,
              config.messaging.outboxSendTimeoutMs,
            ),
        },
        {
          provide: PublishOutboxBatch,
          inject: [UNIT_OF_WORK, SqsEventPublisher, CLOCK, APP_CONFIG],
          useFactory: (
            unitOfWork: UnitOfWork,
            publisher: SqsEventPublisher,
            clock: Clock,
            config: AppConfig,
          ) =>
            new PublishOutboxBatch(unitOfWork, publisher, clock, {
              batchSize: config.messaging.outboxBatchSize,
            }),
        },
        {
          provide: ReprocessPendingReferences,
          inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, ID_GENERATOR, APP_CONFIG],
          useFactory: (
            unitOfWork: UnitOfWork,
            settlement: WagerSettlement,
            clock: Clock,
            ids: IdGenerator,
            config: AppConfig,
          ) =>
            new ReprocessPendingReferences(unitOfWork, settlement, clock, ids, {
              batchSize: config.messaging.pendingReferenceBatchSize,
              leaseMs: config.messaging.pendingReferenceLeaseMs,
            }),
        },
        {
          provide: WagerTransactionConsumer,
          inject: [SQS_CLIENT, QueueUrls, SubmitWagerTransaction, APP_CONFIG, LOGGER],
          useFactory: (
            client: SQSClient,
            queues: QueueUrls,
            submit: SubmitWagerTransaction,
            config: AppConfig,
            logger: AppLogger,
          ) =>
            new WagerTransactionConsumer(
              client,
              queues,
              submit,
              {
                queueName: config.sqs.wagerQueue,
                dlqName: config.sqs.wagerDlq,
                consumerName: config.messaging.consumerName,
                waitTimeSeconds: config.messaging.waitTimeSeconds,
                batchSize: config.messaging.receiveBatchSize,
                maxReceiveCount: config.sqs.maxReceiveCount,
                retryBaseDelaySeconds: config.messaging.retryBaseDelaySeconds,
                shutdownGraceMs: config.shutdownGraceMs,
                beforeAck:
                  config.faultInjection === 'crash-after-commit-before-ack'
                    ? () => crashOnPurpose(logger)
                    : undefined,
              },
              logger.child({ component: 'wager-consumer' }),
            ),
        },
        {
          provide: OUTBOX_WORKER,
          inject: [PublishOutboxBatch, APP_CONFIG, LOGGER],
          useFactory: (publish: PublishOutboxBatch, config: AppConfig, logger: AppLogger) =>
            new PollingWorker(
              'outbox-publisher',
              async () => (await publish.run()).attempted,
              { idleDelayMs: config.messaging.outboxIdleDelayMs },
              logger.child({ component: 'outbox-publisher' }),
            ),
        },
        {
          provide: PENDING_REFERENCE_WORKER,
          inject: [ReprocessPendingReferences, APP_CONFIG, LOGGER],
          useFactory: (reprocess: ReprocessPendingReferences, config: AppConfig, logger: AppLogger) =>
            new PollingWorker(
              'pending-reference',
              async () => (await reprocess.run()).claimed,
              { idleDelayMs: config.messaging.pendingReferenceIdleDelayMs },
              logger.child({ component: 'pending-reference' }),
            ),
        },
      ],
      exports: [PublishOutboxBatch, ReprocessPendingReferences, WagerTransactionConsumer],
    };
  }

  onApplicationBootstrap(): void {
    if (this.config.roles.has('consumer')) {
      this.consumer.start();
    }
    if (this.config.roles.has('outbox')) {
      this.outboxWorker.start();
    }
    if (this.config.roles.has('pending-ref')) {
      this.pendingReferenceWorker.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all([this.consumer.stop(), this.outboxWorker.stop(), this.pendingReferenceWorker.stop()]);
  }
}

/** Falha provocada pelos testes de processo: morre como num SIGKILL, depois do commit e antes do ack. */
async function crashOnPurpose(logger: AppLogger): Promise<never> {
  logger.warn('fault injection: process crashing after commit, before ack');
  process.exit(137);
}
