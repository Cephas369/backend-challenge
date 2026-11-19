import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';

/** Resolve (e memoriza) a URL de cada fila pelo nome configurado. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  get(queueName: string): Promise<string> {
    let url = this.cache.get(queueName);
    if (url === undefined) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: queueName })).then((result) => {
        if (result.QueueUrl === undefined) {
          throw new Error(`fila ${queueName} sem URL`);
        }
        return result.QueueUrl;
      });
      // falha não fica em cache: a próxima chamada tenta de novo
      url.catch(() => this.cache.delete(queueName));
      this.cache.set(queueName, url);
    }
    return url;
  }
}
