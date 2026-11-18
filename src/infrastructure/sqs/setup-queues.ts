import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueNameExists,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../config/config';
import { createLogger } from '../observability/logger';
import { createSqsClient } from './sqs.client';

export interface QueueTopology {
  readonly wagerQueue: string;
  readonly wagerDlq: string;
  readonly eventsQueue: string;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
}

export interface QueueUrls {
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  readonly eventsQueueUrl: string;
}

const FOURTEEN_DAYS_IN_SECONDS = String(14 * 24 * 60 * 60);

/**
 * Cria (ou converge) as filas FIFO do sistema. A deduplicação por conteúdo fica desligada:
 * o produtor informa `MessageDeduplicationId` explicitamente, e a deduplicação do broker é
 * só otimização. Quem garante as invariantes é o banco.
 */
export async function ensureQueues(client: SQSClient, topology: QueueTopology): Promise<QueueUrls> {
  const wagerDlqUrl = await ensureFifoQueue(client, topology.wagerDlq, {
    MessageRetentionPeriod: FOURTEEN_DAYS_IN_SECONDS,
  });
  const deadLetterTargetArn = await queueArn(client, wagerDlqUrl);
  const wagerQueueUrl = await ensureFifoQueue(client, topology.wagerQueue, {
    VisibilityTimeout: String(topology.visibilityTimeoutSeconds),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: topology.maxReceiveCount }),
  });
  const eventsQueueUrl = await ensureFifoQueue(client, topology.eventsQueue, {});
  return { wagerQueueUrl, wagerDlqUrl, eventsQueueUrl };
}

async function ensureFifoQueue(
  client: SQSClient,
  name: string,
  attributes: Record<string, string>,
): Promise<string> {
  try {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: name,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
      }),
    );
    return requireUrl(created.QueueUrl, name);
  } catch (error) {
    if (!(error instanceof QueueNameExists)) {
      throw error;
    }
    // a fila já existe com atributos diferentes: converge os atributos mutáveis
    const existing = await client.send(new GetQueueUrlCommand({ QueueName: name }));
    const url = requireUrl(existing.QueueUrl, name);
    if (Object.keys(attributes).length > 0) {
      await client.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: attributes }));
    }
    return url;
  }
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const result = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }),
  );
  const arn = result.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`fila sem QueueArn: ${queueUrl}`);
  }
  return arn;
}

function requireUrl(url: string | undefined, name: string): string {
  if (url === undefined) {
    throw new Error(`SQS não devolveu a URL da fila ${name}`);
  }
  return url;
}

if (import.meta.main) {
  const config = loadConfig(process.env);
  const logger = createLogger({ level: config.log.level }).child({ component: 'sqs-setup' });
  const client = createSqsClient(config.sqs);
  try {
    const urls = await ensureQueues(client, config.sqs);
    logger.info({ queues: urls }, 'sqs queues ready');
  } catch (error) {
    logger.fatal({ err: error }, 'sqs setup failed');
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}
