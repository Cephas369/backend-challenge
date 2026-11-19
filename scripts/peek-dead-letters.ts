import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { loadConfig } from '../src/infrastructure/config/config';
import { QueueUrls } from '../src/infrastructure/sqs/queue-urls';
import { createSqsClient } from '../src/infrastructure/sqs/sqs.client';

/**
 * Mostra até 10 mensagens da DLQ com o motivo gravado pelo consumer, sem removê-las
 * (visibilidade zero: continuam na fila para quem for tratá-las).
 *   bun run sqs:dlq
 */
const config = loadConfig(process.env);
const client = createSqsClient(config.sqs);

try {
  const { Messages: messages = [] } = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: await new QueueUrls(client).get(config.sqs.wagerDlq),
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  if (messages.length === 0) {
    console.log(`${config.sqs.wagerDlq} está vazia`);
  }
  for (const message of messages) {
    const attribute = (name: string) => message.MessageAttributes?.[name]?.StringValue;
    console.log(
      JSON.stringify({
        reason: attribute('dlq-reason') ?? '(movida pelo redrive policy, sem motivo)',
        detail: attribute('dlq-detail'),
        receiveCount: attribute('receive-count'),
        sourceMessageId: attribute('source-message-id'),
        body: parsedOrRaw(message.Body),
      }),
    );
  }
} finally {
  client.destroy();
}

function parsedOrRaw(body: string | undefined): unknown {
  try {
    return body === undefined ? undefined : JSON.parse(body);
  } catch {
    return body;
  }
}
