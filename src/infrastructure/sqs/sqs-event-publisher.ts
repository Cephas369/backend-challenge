import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishResult } from '../../application/messaging/publish-outbox';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { QueueUrls } from './queue-urls';

/** O SQS aceita no máximo 10 mensagens por SendMessageBatch. */
const SQS_BATCH_LIMIT = 10;

/**
 * Publica os eventos da outbox na fila FIFO de eventos. `MessageGroupId` = aggregateId mantém a ordem
 * por agregado; `MessageDeduplicationId` = eventId deixa o broker descartar repetições na janela de
 * 5 minutos. Isso é só otimização: quem garante é o consumidor, deduplicando por eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queues: QueueUrls,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult[]> {
    const queueUrl = await this.queues.get(this.queueName);
    const results: PublishResult[] = [];
    for (let start = 0; start < messages.length; start += SQS_BATCH_LIMIT) {
      const chunk = messages.slice(start, start + SQS_BATCH_LIMIT);
      const response = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((message, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
          })),
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      const failed = new Map((response.Failed ?? []).map((entry) => [entry.Id, entry.Message ?? entry.Code]));
      chunk.forEach((message, index) => {
        const error = failed.get(String(index));
        results.push({ id: message.id, ok: !failed.has(String(index)), error });
      });
    }
    return results;
  }
}
