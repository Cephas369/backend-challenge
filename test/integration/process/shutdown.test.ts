import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { createMigratedDatabase, type MigratedDatabase } from '../../support/database';
import { spawnApp } from '../../support/process';
import {
  createTestQueues,
  createTestSqsClient,
  type TestQueues,
  uniqueQueueTopology,
} from '../../support/sqs';

let db: MigratedDatabase;
let sqsClient: SQSClient;
let queues: TestQueues;

beforeAll(async () => {
  db = await createMigratedDatabase('shutdown');
  sqsClient = createTestSqsClient();
  queues = await createTestQueues(sqsClient, uniqueQueueTopology('shutdown'));
});

afterAll(async () => {
  await queues?.drop();
  sqsClient?.destroy();
  await db?.close();
});

describe('ciclo de vida do processo', () => {
  test('SIGTERM para consumer e workers (cancelando o long polling) e só depois fecha banco e SQS', async () => {
    const app = spawnApp({
      PORT: '0',
      LOG_LEVEL: 'info',
      APP_ROLES: 'api,consumer,outbox,pending-ref',
      DATABASE_URL: db.database.url,
      SQS_WAGER_QUEUE: queues.topology.wagerQueue,
      SQS_WAGER_DLQ: queues.topology.wagerDlq,
      SQS_EVENTS_QUEUE: queues.topology.eventsQueue,
      // long polling de 20 s: o shutdown precisa cancelá-lo em vez de esperar
      SQS_WAIT_TIME_SECONDS: '20',
    });

    const listening = await app.waitForLog(
      (line) => line.msg === 'http server listening',
      'servidor HTTP no ar',
    );
    await app.waitForLog((line) => line.msg === 'consumer started', 'consumer no ar');
    const ready = await fetch(`http://127.0.0.1:${listening.port}/health/ready`);
    expect(ready.status).toBe(200);

    const signalledAt = Date.now();
    app.process.kill('SIGTERM');
    const exitCode = await Promise.race([
      app.process.exited,
      Bun.sleep(10_000).then(() => 'timeout' as const),
    ]);
    const shutdownMs = Date.now() - signalledAt;

    expect(exitCode).not.toBe('timeout');
    expect(shutdownMs).toBeLessThan(5_000);
    const messages = app.logs.map((line) => line.msg);
    const position = (message: string) => messages.indexOf(message);
    for (const expected of [
      'shutdown started',
      'consumer stopped',
      'worker stopped',
      'database pool closed',
      'sqs client closed',
    ]) {
      expect(messages).toContain(expected);
    }
    // consumer e workers param antes de o pool do banco fechar
    expect(position('consumer stopped')).toBeLessThan(position('database pool closed'));
    expect(messages.lastIndexOf('worker stopped')).toBeLessThan(position('database pool closed'));
    // o Nest reenvia o sinal a si mesmo depois dos hooks; terminar por SIGTERM é o esperado
    expect(app.process.signalCode === 'SIGTERM' || exitCode === 0).toBe(true);
    expect(await app.stderr()).toBe('');
  });
});
