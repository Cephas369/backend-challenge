import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../config/config';

/** Credenciais vêm da cadeia padrão do SDK (variáveis AWS_* no ambiente local). */
export function createSqsClient(config: Pick<SqsConfig, 'region' | 'endpoint'>): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  });
}
