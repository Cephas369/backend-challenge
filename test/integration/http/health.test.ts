import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp, listeningPort } from '../../../src/bootstrap';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { buildTestConfig, type TestConfigOverrides } from '../../support/config';
import { createTestDatabase, type TestDatabase } from '../../support/database';
import {
  createTestQueues,
  createTestSqsClient,
  type TestQueues,
  uniqueQueueTopology,
} from '../../support/sqs';

let database: TestDatabase;
let sqsClient: SQSClient;
let queues: TestQueues;
const runningApps: NestExpressApplication[] = [];

beforeAll(async () => {
  database = await createTestDatabase('health');
  sqsClient = createTestSqsClient();
  queues = await createTestQueues(sqsClient, uniqueQueueTopology('health'));
});

afterAll(async () => {
  await Promise.all(runningApps.map((app) => app.close()));
  await queues?.drop();
  sqsClient?.destroy();
  await database?.drop();
});

async function startApp(overrides: TestConfigOverrides = {}): Promise<string> {
  const config = buildTestConfig({
    databaseUrl: database.url,
    healthTimeoutMs: 500,
    ...overrides,
    sqs: { ...queues.topology, ...overrides.sqs },
  });
  const app = await createApp(config, createLogger({ level: 'silent' }));
  runningApps.push(app);
  await app.listen(0, '127.0.0.1');
  return `http://127.0.0.1:${listeningPort(app)}`;
}

describe('health checks', () => {
  test('live e ready respondem 200 com PostgreSQL e SQS de pé', async () => {
    const baseUrl = await startApp();

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', checks: { database: 'up', sqs: 'up' } });
  });

  test('sem SQS, ready responde 503 e live continua 200', async () => {
    // porta 9 (discard) recusa conexão: simula o broker fora do ar
    const baseUrl = await startApp({ sqs: { endpoint: 'http://127.0.0.1:9' } });

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable', checks: { database: 'up', sqs: 'down' } });
  });

  test('sem PostgreSQL, a aplicação sobe, ready responde 503 e live continua 200', async () => {
    const unreachable = new URL(database.url);
    unreachable.port = '9';
    const baseUrl = await startApp({ databaseUrl: unreachable.toString() });

    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({ status: 'unavailable', checks: { database: 'down', sqs: 'up' } });
  });

  test('repete o X-Correlation-Id recebido e gera um novo quando ausente ou inseguro', async () => {
    const baseUrl = await startApp();

    const correlationIdFor = async (value?: string) => {
      const response = await fetch(`${baseUrl}/health/live`, {
        headers: value === undefined ? {} : { 'x-correlation-id': value },
      });
      return response.headers.get('x-correlation-id');
    };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    expect(await correlationIdFor('corr-123')).toBe('corr-123');
    expect(await correlationIdFor()).toMatch(uuid);
    // valores válidos em HTTP, mas fora do formato aceito para log
    expect(await correlationIdFor('com espaco; e ponto e virgula')).toMatch(uuid);
    expect(await correlationIdFor('x'.repeat(200))).toMatch(uuid);
  });
});
