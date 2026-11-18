import { DeleteQueueCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { ensureQueues, type QueueTopology, type QueueUrls } from '../../src/infrastructure/sqs/setup-queues';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs.client';
import { requiredEnv, uniqueSuffix } from './unique';

export function createTestSqsClient(): SQSClient {
  return createSqsClient({ region: requiredEnv('AWS_REGION'), endpoint: requiredEnv('SQS_ENDPOINT') });
}

/** Filas com nome único por execução: `PurgeQueue` só roda a cada 60 s, então não dá para reaproveitar. */
export function uniqueQueueTopology(label: string, overrides: Partial<QueueTopology> = {}): QueueTopology {
  const prefix = `t-${label}-${uniqueSuffix()}`;
  return {
    wagerQueue: `${prefix}-wager.fifo`,
    wagerDlq: `${prefix}-wager-dlq.fifo`,
    eventsQueue: `${prefix}-events.fifo`,
    maxReceiveCount: 5,
    visibilityTimeoutSeconds: 30,
    ...overrides,
  };
}

export interface TestQueues {
  readonly topology: QueueTopology;
  readonly urls: QueueUrls;
  drop(): Promise<void>;
}

export async function createTestQueues(client: SQSClient, topology: QueueTopology): Promise<TestQueues> {
  let urls: QueueUrls;
  try {
    urls = await ensureQueues(client, topology);
  } catch (error) {
    throw new Error(
      `SQS de teste indisponível em ${requiredEnv('SQS_ENDPOINT')} — rode \`bun run infra:up\` antes dos testes de integração`,
      { cause: error },
    );
  }
  return {
    topology,
    urls,
    drop: async () => {
      for (const queueUrl of [urls.wagerQueueUrl, urls.wagerDlqUrl, urls.eventsQueueUrl]) {
        await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      }
    },
  };
}
