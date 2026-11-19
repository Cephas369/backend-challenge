import {
  type AppConfig,
  type AppRole,
  loadConfig,
  type MessagingConfig,
  type SqsConfig,
} from '../../src/infrastructure/config/config';

export interface TestConfigOverrides {
  readonly databaseUrl?: string;
  readonly lockTimeoutMs?: number;
  readonly sqs?: Partial<SqsConfig>;
  readonly messaging?: Partial<MessagingConfig>;
  readonly healthTimeoutMs?: number;
  /**
   * Papéis ligados. Padrão: só "api". Consumer e workers ficam desligados a menos que o teste
   * os peça, junto com filas próprias, para nunca tocarem as filas do ambiente de desenvolvimento.
   */
  readonly roles?: readonly AppRole[];
}

/** Configuração a partir do ambiente de teste, com os ajustes de cada suíte. */
export function buildTestConfig(overrides: TestConfigOverrides = {}): AppConfig {
  const base = loadConfig(process.env);
  return {
    ...base,
    database: {
      ...base.database,
      url: overrides.databaseUrl ?? base.database.url,
      lockTimeoutMs: overrides.lockTimeoutMs ?? base.database.lockTimeoutMs,
    },
    sqs: { ...base.sqs, ...overrides.sqs },
    messaging: { ...base.messaging, ...overrides.messaging },
    health: { timeoutMs: overrides.healthTimeoutMs ?? base.health.timeoutMs },
    roles: new Set(overrides.roles ?? ['api']),
  };
}
