import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  createTestQueues,
  createTestSqsClient,
  type TestQueues,
  uniqueQueueTopology,
} from '../../support/sqs';

let client: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  client = createTestSqsClient();
  queues = await createTestQueues(client, uniqueQueueTopology('sqs', { maxReceiveCount: 2 }));
});

afterAll(async () => {
  await queues?.drop();
  client?.destroy();
});

function send(group: string, deduplicationId: string, body = deduplicationId) {
  return client.send(
    new SendMessageCommand({
      QueueUrl: queues.urls.wagerQueueUrl,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: deduplicationId,
    }),
  );
}

async function receive(queueUrl: string, maxMessages = 10): Promise<Message[]> {
  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }),
  );
  return result.Messages ?? [];
}

function ack(queueUrl: string, message: Message) {
  return client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
}

function makeVisibleAgain(message: Message) {
  return client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: queues.urls.wagerQueueUrl,
      ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: 0,
    }),
  );
}

describe('emulador SQS: recursos de que o sistema depende', () => {
  test('a fila FIFO descarta envio repetido com o mesmo MessageDeduplicationId', async () => {
    await send('group-dedup', 'dedup-1');
    await send('group-dedup', 'dedup-1');

    const messages = await receive(queues.urls.wagerQueueUrl);

    expect(messages.map((message) => message.Body)).toEqual(['dedup-1']);
    await ack(queues.urls.wagerQueueUrl, messages[0] as Message);
  });

  test('mensagens do mesmo grupo saem em ordem, e o grupo fica bloqueado enquanto há uma em voo', async () => {
    await send('group-order', 'order-a');
    await send('group-order', 'order-b');

    const [first] = await receive(queues.urls.wagerQueueUrl, 1);
    expect(first?.Body).toBe('order-a');
    expect(await receive(queues.urls.wagerQueueUrl, 1)).toEqual([]);

    await ack(queues.urls.wagerQueueUrl, first as Message);
    const [second] = await receive(queues.urls.wagerQueueUrl, 1);
    expect(second?.Body).toBe('order-b');
    await ack(queues.urls.wagerQueueUrl, second as Message);
  });

  test('visibilidade zerada devolve a mensagem e o ApproximateReceiveCount cresce', async () => {
    await send('group-visibility', 'visibility-1');

    const [firstDelivery] = await receive(queues.urls.wagerQueueUrl);
    expect(firstDelivery?.Attributes?.ApproximateReceiveCount).toBe('1');
    await makeVisibleAgain(firstDelivery as Message);

    const [secondDelivery] = await receive(queues.urls.wagerQueueUrl);
    expect(secondDelivery?.Body).toBe('visibility-1');
    expect(secondDelivery?.Attributes?.ApproximateReceiveCount).toBe('2');
    await ack(queues.urls.wagerQueueUrl, secondDelivery as Message);
  });

  test('passado o maxReceiveCount, o redrive move a mensagem para a DLQ', async () => {
    await send('group-redrive', 'redrive-1');

    for (let delivery = 1; delivery <= 2; delivery += 1) {
      const [message] = await receive(queues.urls.wagerQueueUrl);
      expect(message?.Body).toBe('redrive-1');
      await makeVisibleAgain(message as Message);
    }

    expect(await receive(queues.urls.wagerQueueUrl)).toEqual([]);
    const [deadLetter] = await receive(queues.urls.wagerDlqUrl);
    expect(deadLetter?.Body).toBe('redrive-1');
    await ack(queues.urls.wagerDlqUrl, deadLetter as Message);
  });
});
