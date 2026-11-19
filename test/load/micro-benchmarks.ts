import '../setup';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
} from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { createMigratedDatabase } from '../support/database';
import { createTestSqsClient } from '../support/sqs';
import { uniqueSuffix } from '../support/unique';
import { summarize } from './stats';

/**
 * Micro-medições que sustentam a análise do teste de carga (`bun run test:load:micro`):
 *   1. ida e volta e commit no PostgreSQL (o custo de cada comando dentro do lock da wallet);
 *   2. plano e custo da claim da outbox com 40 mil eventos pendentes;
 *   3. custo de `SendMessageBatch` na MiniStack conforme a fila FIFO acumula histórico.
 */
const format = (samples: number[]) => {
  const summary = summarize(samples);
  return `p50 ${summary.p50.toFixed(2)} ms · p99 ${summary.p99.toFixed(2)} ms`;
};

async function timed(times: number, run: (index: number) => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) {
    const startedAt = performance.now();
    await run(index);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

async function database(): Promise<void> {
  const db = await createMigratedDatabase('micro');
  const sql = new SQL(db.database.url);
  try {
    await timed(200, () => sql`select 1`);
    console.log(`PostgreSQL, ida e volta (select 1): ${format(await timed(3_000, () => sql`select 1`))}`);
    const em = () => db.orm.em.fork();
    await timed(200, () => em().execute('select 1'));
    console.log(
      `PostgreSQL, ida e volta pela MikroORM: ${format(await timed(3_000, () => em().execute('select 1')))}`,
    );
    await sql`create table micro_commit (id serial primary key, value int)`;
    const commits = await timed(1_000, (index) =>
      sql.begin((tx) => tx`insert into micro_commit (value) values (${index})`),
    );
    console.log(`PostgreSQL, begin + insert + commit: ${format(commits)}`);

    await em().execute(
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
       select gen_random_uuid(), gen_random_uuid(), 'WalletBalanceChanged', '{}'::jsonb,
              now() - (g || ' ms')::interval, now() - (g || ' ms')::interval
         from generate_series(1, 40000) g`,
    );
    await em().execute('analyze outbox_messages');
    const plan = await em().execute<Record<string, string>[]>(
      `explain (analyze) select * from outbox_messages
        where published_at is null and next_attempt_at <= now()
        order by occurred_at asc, id asc limit 10 for update skip locked`,
    );
    const lines = plan.map((row) => row['QUERY PLAN'] ?? '');
    console.log(
      `Claim da outbox com 40 mil pendentes: ${lines.find((line) => line.includes('Scan'))?.trim()} · ` +
        `${lines.find((line) => line.startsWith('Execution Time'))}`,
    );
  } finally {
    await sql.close();
    await db.close();
  }
}

async function broker(): Promise<void> {
  const sqs = createTestSqsClient();
  const { QueueUrl: queueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: `micro-${uniqueSuffix()}.fifo`, Attributes: { FifoQueue: 'true' } }),
  );
  let sequence = 0;
  const batch = () =>
    sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Array.from({ length: 10 }, (_, index) => {
          sequence += 1;
          return {
            Id: `e${index}`,
            MessageBody: 'x'.repeat(300),
            MessageGroupId: `g${sequence % 100}`,
            MessageDeduplicationId: `d${sequence}`,
          };
        }),
      }),
    );
  const fill = async (messages: number) => {
    const target = sequence + messages;
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (sequence < target) {
          await batch();
        }
      }),
    );
  };
  const drain = async () => {
    let emptyRounds = 0;
    while (emptyRounds < 3) {
      const { Messages: messages = [] } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
      );
      if (messages.length === 0) {
        emptyRounds += 1;
        continue;
      }
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((message, index) => ({
            Id: `m${index}`,
            ReceiptHandle: message.ReceiptHandle,
          })),
        }),
      );
    }
  };
  try {
    console.log(`SQS, SendMessageBatch (10) numa fila FIFO nova: ${format(await timed(40, batch))}`);
    await fill(5_000);
    console.log(`SQS, depois de 5 mil mensagens: ${format(await timed(40, batch))}`);
    await fill(10_000);
    console.log(`SQS, depois de 15 mil mensagens: ${format(await timed(40, batch))}`);
    await drain();
    console.log(`SQS, mesma fila depois de esvaziada: ${format(await timed(40, batch))}`);
  } finally {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    sqs.destroy();
  }
}

await database();
await broker();
