import { DeleteMessageBatchCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';

/**
 * Consumidor da fila de eventos, no papel dos consumidores downstream: recebe, deduplica por `eventId`
 * (a entrega é at-least-once) e apaga. Sem ele a fila só cresce durante o teste, e o custo de cada
 * envio na MiniStack cresce com a profundidade da fila, então o teste mediria o emulador.
 */
export function startEventSink(sqs: SQSClient, queueUrl: string, workers: number) {
  const eventIds = new Set<string>();
  let deliveries = 0;
  let running = true;

  const worker = async (): Promise<void> => {
    while (running) {
      const { Messages: messages = [] } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      if (messages.length === 0) {
        continue;
      }
      for (const message of messages) {
        // mensagens sem eventId são da sonda do broker
        const { eventId } = JSON.parse(message.Body ?? '{}') as { eventId?: string };
        if (eventId !== undefined) {
          eventIds.add(eventId);
          deliveries += 1;
        }
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
  const loops = Array.from({ length: workers }, () => worker());

  return {
    /** Eventos distintos recebidos e total de entregas (inclui as repetidas). */
    stats: () => ({ distinct: eventIds.size, deliveries }),
    async waitFor(distinct: number, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (eventIds.size < distinct && Date.now() < deadline) {
        await Bun.sleep(250);
      }
      return eventIds.size >= distinct;
    },
    async stop(): Promise<void> {
      running = false;
      await Promise.all(loops);
    },
  };
}
