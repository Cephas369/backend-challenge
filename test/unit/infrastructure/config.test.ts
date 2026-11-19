import { describe, expect, test } from 'bun:test';
import { InvalidConfigError, loadConfig } from '../../../src/infrastructure/config/config';

const required = { DATABASE_URL: 'postgres://user:pass@localhost:5432/db' };

describe('loadConfig', () => {
  test('aplica os defaults quando só o obrigatório é informado', () => {
    const config = loadConfig(required);

    expect(config.env).toBe('development');
    expect(config.http.port).toBe(3000);
    expect(config.log.level).toBe('info');
    expect(config.sqs).toEqual({
      region: 'us-east-1',
      endpoint: undefined,
      wagerQueue: 'wager-transactions.fifo',
      wagerDlq: 'wager-transactions-dlq.fifo',
      eventsQueue: 'wagering-events.fifo',
      maxReceiveCount: 5,
      visibilityTimeoutSeconds: 30,
    });
  });

  test('converte números recebidos como texto', () => {
    const config = loadConfig({ ...required, PORT: '8080', SQS_MAX_RECEIVE_COUNT: '3' });

    expect(config.http.port).toBe(8080);
    expect(config.sqs.maxReceiveCount).toBe(3);
  });

  test('exige DATABASE_URL com protocolo postgres', () => {
    expect(() => loadConfig({})).toThrow(InvalidConfigError);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://user:pass@localhost/db' })).toThrow(InvalidConfigError);
  });

  test('não expõe a senha da URL na mensagem de erro', () => {
    const attempt = () => loadConfig({ DATABASE_URL: 'mysql://user:segredo-forte@localhost/db' });

    expect(attempt).toThrow(InvalidConfigError);
    expect(attempt).not.toThrow(/segredo-forte/);
  });

  test('rejeita fila que não é FIFO', () => {
    expect(() => loadConfig({ ...required, SQS_WAGER_QUEUE: 'wager-transactions' })).toThrow(/FIFO/);
  });

  test('APP_ROLES escolhe os papéis da instância; todos por padrão; papel desconhecido é recusado', () => {
    expect([...loadConfig(required).roles]).toEqual(['api', 'consumer', 'outbox', 'pending-ref']);
    expect([...loadConfig({ ...required, APP_ROLES: 'consumer, outbox' }).roles]).toEqual([
      'consumer',
      'outbox',
    ]);
    expect(() => loadConfig({ ...required, APP_ROLES: 'api,cron' })).toThrow(InvalidConfigError);
  });

  test('injeção de falha só é aceita com NODE_ENV=test', () => {
    const crash = { ...required, FAULT_INJECTION: 'crash-after-commit-before-ack' };

    expect(() => loadConfig({ ...crash, NODE_ENV: 'production' })).toThrow(/FAULT_INJECTION/);
    expect(loadConfig({ ...crash, NODE_ENV: 'test' }).faultInjection).toBe('crash-after-commit-before-ack');
    expect(loadConfig(required).faultInjection).toBe('none');
  });
});
