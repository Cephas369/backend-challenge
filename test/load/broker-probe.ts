import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';

/**
 * Sonda do broker: a cada `intervalMs`, mede um `SendMessageBatch` de 10 mensagens na mesma fila em
 * que os publishers da outbox escrevem. Separa o custo do broker do custo da aplicação: se a sonda
 * fica lenta junto com a publicação, o gargalo está no broker. As mensagens não têm `eventId`, e o
 * consumidor de eventos as ignora.
 */
export function startBrokerProbe(sqs: SQSClient, queueUrl: string, intervalMs = 2_000) {
  const samples: { readonly at: number; readonly ms: number }[] = [];
  let running = true;
  let sequence = 0;
  const loop = (async () => {
    while (running) {
      const startedAt = performance.now();
      try {
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: Array.from({ length: 10 }, (_, index) => {
              sequence += 1;
              return {
                Id: `p${index}`,
                MessageBody: '{"probe":true}',
                MessageGroupId: `probe-${sequence % 10}`,
                MessageDeduplicationId: `probe-${sequence}-${Date.now()}`,
              };
            }),
          }),
        );
        samples.push({ at: Date.now(), ms: performance.now() - startedAt });
      } catch {
        // uma sonda perdida não invalida a medição
      }
      await Bun.sleep(intervalMs);
    }
  })();
  return {
    samples,
    async stop(): Promise<void> {
      running = false;
      await loop;
    },
  };
}

export type BrokerProbe = ReturnType<typeof startBrokerProbe>;
