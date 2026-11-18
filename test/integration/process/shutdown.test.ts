import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import { spawnApp } from '../../support/process';
import {
  createTestQueues,
  createTestSqsClient,
  type TestQueues,
  uniqueQueueTopology,
} from '../../support/sqs';

let database: TestDatabase;
let sqsClient: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  database = await createTestDatabase('shutdown');
  sqsClient = createTestSqsClient();
  queues = await createTestQueues(sqsClient, uniqueQueueTopology('shutdown'));
});

afterAll(async () => {
  await queues?.drop();
  sqsClient?.destroy();
  await database?.drop();
});

describe('ciclo de vida do processo', () => {
  test('SIGTERM fecha banco e SQS antes de o processo terminar', async () => {
    const app = spawnApp({
      PORT: '0',
      LOG_LEVEL: 'info',
      DATABASE_URL: database.url,
      SQS_WAGER_QUEUE: queues.topology.wagerQueue,
      SQS_WAGER_DLQ: queues.topology.wagerDlq,
      SQS_EVENTS_QUEUE: queues.topology.eventsQueue,
    });

    const listening = await app.waitForLog(
      (line) => line.msg === 'http server listening',
      'servidor HTTP no ar',
    );
    const ready = await fetch(`http://127.0.0.1:${listening.port}/health/ready`);
    expect(ready.status).toBe(200);

    app.process.kill('SIGTERM');
    const exitCode = await Promise.race([
      app.process.exited,
      Bun.sleep(10_000).then(() => 'timeout' as const),
    ]);

    expect(exitCode).not.toBe('timeout');
    const messages = app.logs.map((line) => line.msg);
    expect(messages).toContain('shutdown started');
    expect(messages).toContain('database pool closed');
    expect(messages).toContain('sqs client closed');
    // o Nest reenvia o sinal a si mesmo depois dos hooks; terminar por SIGTERM é o esperado
    expect(app.process.signalCode === 'SIGTERM' || exitCode === 0).toBe(true);
    expect(await app.stderr()).toBe('');
  });
});
