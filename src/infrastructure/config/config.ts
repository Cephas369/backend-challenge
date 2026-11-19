import { z } from 'zod';

const fifoQueueName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,75}\.fifo$/, 'nome de fila FIFO inválido (deve terminar em .fifo)');

/**
 * Papéis de uma instância: a mesma imagem roda qualquer combinação deles. Os health checks
 * ficam sempre no ar.
 */
export const APP_ROLES = ['api', 'consumer', 'outbox', 'pending-ref'] as const;

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
  APP_ROLES: z
    .string()
    .default(APP_ROLES.join(','))
    .transform((value) => value.split(',').map((role) => role.trim()))
    .pipe(z.array(z.enum(APP_ROLES)).min(1)),
  CONSUMER_NAME: z.string().min(1).default('wagering-processor'),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_RECEIVE_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  SQS_RETRY_BASE_DELAY_SECONDS: z.coerce.number().int().min(1).max(900).default(2),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(10),
  OUTBOX_IDLE_DELAY_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_SEND_TIMEOUT_MS: z.coerce.number().int().min(100).default(3000),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  PENDING_REFERENCE_IDLE_DELAY_MS: z.coerce.number().int().min(10).default(1000),
  PENDING_REFERENCE_LEASE_MS: z.coerce.number().int().min(100).default(30_000),
  REFERENCE_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(1).default(1000),
  REFERENCE_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).default(60_000),
  REFERENCE_TTL_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(15 * 60_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(20_000),
});

export type LogLevel = z.infer<typeof environmentSchema>['LOG_LEVEL'];
export type AppRole = (typeof APP_ROLES)[number];

export interface MessagingConfig {
  /** Identidade lógica do consumidor na inbox: a mesma em todas as instâncias. */
  readonly consumerName: string;
  readonly waitTimeSeconds: number;
  readonly receiveBatchSize: number;
  readonly retryBaseDelaySeconds: number;
  readonly outboxBatchSize: number;
  readonly outboxIdleDelayMs: number;
  readonly outboxSendTimeoutMs: number;
  readonly pendingReferenceBatchSize: number;
  readonly pendingReferenceIdleDelayMs: number;
  readonly pendingReferenceLeaseMs: number;
}

export interface ReferenceRetryConfig {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly ttlMs: number;
}

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
  readonly roles: ReadonlySet<AppRole>;
  readonly messaging: MessagingConfig;
  readonly referenceRetry: ReferenceRetryConfig;
  readonly shutdownGraceMs: number;
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
    roles: new Set(env.APP_ROLES),
    messaging: {
      consumerName: env.CONSUMER_NAME,
      waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
      receiveBatchSize: env.SQS_RECEIVE_BATCH_SIZE,
      retryBaseDelaySeconds: env.SQS_RETRY_BASE_DELAY_SECONDS,
      outboxBatchSize: env.OUTBOX_BATCH_SIZE,
      outboxIdleDelayMs: env.OUTBOX_IDLE_DELAY_MS,
      outboxSendTimeoutMs: env.OUTBOX_SEND_TIMEOUT_MS,
      pendingReferenceBatchSize: env.PENDING_REFERENCE_BATCH_SIZE,
      pendingReferenceIdleDelayMs: env.PENDING_REFERENCE_IDLE_DELAY_MS,
      pendingReferenceLeaseMs: env.PENDING_REFERENCE_LEASE_MS,
    },
    referenceRetry: {
      initialDelayMs: env.REFERENCE_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: env.REFERENCE_RETRY_MAX_DELAY_MS,
      ttlMs: env.REFERENCE_TTL_MS,
    },
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
  };
}
