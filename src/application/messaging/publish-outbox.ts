import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { ExponentialBackoff } from '../../domain/shared/exponential-backoff';
import type { UnitOfWork } from '../ports/persistence';
import type { Clock } from '../ports/runtime';

export interface PublishResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

/** Porta de publicação: informa o desfecho de cada mensagem (falha parcial não lança). */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult[]>;
}

export interface PublishOutboxOptions {
  readonly batchSize: number;
  readonly backoff?: ExponentialBackoff | undefined;
  /**
   * Ponto de injeção de falha para testes: roda depois do envio e antes do commit. Lançar aqui
   * simula o processo morrendo nesse intervalo (nada é confirmado e a mensagem volta a ficar devida).
   */
  readonly afterPublish?: (() => Promise<void>) | undefined;
}

export interface PublishRound {
  readonly attempted: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * Uma rodada do publisher: trava um lote devido com SKIP LOCKED, publica e grava o resultado
 * na mesma transação. Vários publishers rodam ao mesmo tempo sem pegar a mesma mensagem.
 * Morrer depois do envio e antes do commit gera republicação, e o consumidor deduplica por eventId.
 */
export class PublishOutboxBatch {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
  ) {}

  run(): Promise<PublishRound> {
    return this.unitOfWork.transaction(async ({ outbox }) => {
      const due = await outbox.claimDue(this.clock.now(), this.options.batchSize);
      if (due.length === 0) {
        return { attempted: 0, published: 0, failed: 0 };
      }
      let results: PublishResult[];
      try {
        results = await this.publisher.publish(due);
      } catch (error) {
        results = due.map((message) => ({ id: message.id, ok: false, error: describe(error) }));
      }
      await this.options.afterPublish?.();

      const byId = new Map(results.map((result) => [result.id, result]));
      let published = 0;
      for (const message of due) {
        const result = byId.get(message.id);
        if (result?.ok === true) {
          message.markPublished(this.clock.now());
          published += 1;
        } else {
          message.scheduleRetry(
            this.clock.now(),
            result?.error ?? 'sem resultado do broker',
            this.options.backoff,
          );
        }
        await outbox.save(message);
      }
      return { attempted: due.length, published, failed: due.length - published };
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
