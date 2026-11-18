import { z } from 'zod';

const fifoQueueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'nome de fila FIFO inválido (deve terminar em .fifo)');

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  SQS_ENDPOINT: z.url().optional(),
  SQS_WAGER_QUEUE: fifoQueueName.default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: fifoQueueName.default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: fifoQueueName.default('wagering-events.fifo'),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).max(1000).default(5),
  SQS_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(43_200).default(30),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
});

export type LogLevel = z.infer<typeof environmentSchema>['LOG_LEVEL'];

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly connectTimeoutMs: number;
  /** Espera máxima por um lock de linha antes de desistir como falha transitória. */
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export interface SqsConfig {
  readonly region: string;
  /** Endpoint do emulador (MiniStack). Ausente em AWS real. */
  readonly endpoint: string | undefined;
  readonly wagerQueue: string;
  readonly wagerDlq: string;
  readonly eventsQueue: string;
  readonly maxReceiveCount: number;
  readonly visibilityTimeoutSeconds: number;
}

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly http: { readonly port: number };
  readonly log: { readonly level: LogLevel };
  readonly database: DatabaseConfig;
  readonly sqs: SqsConfig;
  readonly health: { readonly timeoutMs: number };
}

export class InvalidConfigError extends Error {
  override readonly name = 'InvalidConfigError';
}

/**
 * Valida as variáveis de ambiente e devolve a configuração tipada.
 * Falha rápido: a aplicação não sobe com configuração inválida.
 */
export function loadConfig(environment: Record<string, string | undefined>): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new InvalidConfigError(`configuração inválida:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    env: env.NODE_ENV,
    http: { port: env.PORT },
    log: { level: env.LOG_LEVEL },
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
      lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    },
    sqs: {
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      wagerQueue: env.SQS_WAGER_QUEUE,
      wagerDlq: env.SQS_WAGER_DLQ,
      eventsQueue: env.SQS_EVENTS_QUEUE,
      maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
      visibilityTimeoutSeconds: env.SQS_VISIBILITY_TIMEOUT_SECONDS,
    },
    health: { timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS },
  };
}
