import { describe, expect, test } from 'bun:test';
import { addToLogContext, runWithLogContext } from '../../../src/infrastructure/observability/log-context';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { NestPinoLogger } from '../../../src/infrastructure/observability/nest-logger';

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level: 'trace' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line));
      },
    },
  );
  return { logger, lines };
}

describe('logger estruturado', () => {
  test('carrega o contexto de correlação, inclusive depois de await', async () => {
    const { logger, lines } = capturingLogger();

    await runWithLogContext({ correlationId: 'corr-1', walletId: 'wallet-1' }, async () => {
      logger.info('antes');
      await Bun.sleep(1);
      addToLogContext({ transactionId: 'tx-1' });
      logger.info('depois');
    });
    logger.info('fora');

    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'wagering-processor',
      msg: 'antes',
      correlationId: 'corr-1',
      walletId: 'wallet-1',
    });
    expect(lines[1]).toMatchObject({ msg: 'depois', correlationId: 'corr-1', transactionId: 'tx-1' });
    expect(lines[2]).not.toHaveProperty('correlationId');
  });

  test('contextos aninhados herdam do pai sem alterá-lo', () => {
    const { logger, lines } = capturingLogger();

    runWithLogContext({ correlationId: 'corr-1' }, () => {
      runWithLogContext({ messageId: 'msg-1' }, () => logger.info('filho'));
      logger.info('pai');
    });

    expect(lines[0]).toMatchObject({ correlationId: 'corr-1', messageId: 'msg-1' });
    expect(lines[1]).toMatchObject({ correlationId: 'corr-1' });
    expect(lines[1]).not.toHaveProperty('messageId');
  });

  test('omite valores financeiros e payloads', () => {
    const { logger, lines } = capturingLogger();

    logger.info(
      {
        walletId: 'wallet-1',
        money: { amount: '25.00', currency: 'BRL' },
        result: { balance: { amount: '975.00', currency: 'BRL' } },
        payload: { anything: true },
      },
      'transação processada',
    );

    expect(lines[0]).toMatchObject({
      walletId: 'wallet-1',
      money: '[REDACTED]',
      result: { balance: '[REDACTED]' },
      payload: '[REDACTED]',
    });
  });
});

describe('NestPinoLogger', () => {
  test('mapeia contexto, níveis e stack dos logs do Nest', () => {
    const { logger, lines } = capturingLogger();
    const nestLogger = new NestPinoLogger(logger);

    nestLogger.log('Mapped {/health/live, GET} route', 'RouterExplorer');
    nestLogger.error('falhou', 'Error: falhou\n    at algum lugar', 'ExceptionsHandler');
    nestLogger.verbose('detalhe');
    nestLogger.warn(new Error('cuidado'));

    expect(lines[0]).toMatchObject({
      level: 'info',
      context: 'RouterExplorer',
      msg: 'Mapped {/health/live, GET} route',
    });
    expect(lines[1]).toMatchObject({ level: 'error', context: 'ExceptionsHandler', msg: 'falhou' });
    expect(lines[1]?.stack).toContain('at algum lugar');
    expect(lines[2]).toMatchObject({ level: 'trace', msg: 'detalhe' });
    expect(lines[3]).toMatchObject({ level: 'warn', msg: 'cuidado', err: { message: 'cuidado' } });
  });
});
