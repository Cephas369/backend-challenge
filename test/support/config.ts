import { type AppConfig, loadConfig, type SqsConfig } from '../../src/infrastructure/config/config';

export interface TestConfigOverrides {
  readonly databaseUrl?: string;
  readonly sqs?: Partial<SqsConfig>;
  readonly healthTimeoutMs?: number;
}

/** Configuração a partir do ambiente de teste, com os ajustes de cada suíte. */
export function buildTestConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    database: { ...base.database, url: overrides.databaseUrl ?? base.database.url },
    sqs: { ...base.sqs, ...overrides.sqs },
    health: { timeoutMs: overrides.healthTimeoutMs ?? base.health.timeoutMs },
  };
}
