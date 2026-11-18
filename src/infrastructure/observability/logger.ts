import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';
import { currentLogContext } from './log-context';

export type AppLogger = Logger;

/**
 * Campos financeiros e payloads nunca vão para o log (seção 12 do enunciado).
 * O caminho `*.x` cobre um nível de aninhamento, que é como os logs da aplicação são escritos.
 */
export const REDACTED_LOG_PATHS = [
  'payload',
  '*.payload',
  'body',
  '*.body',
  'money',
  '*.money',
  'amount',
  '*.amount',
  'balance',
  '*.balance',
  'headers.authorization',
  '*.headers.authorization',
];

export interface LoggerOptions {
  readonly level: LevelWithSilent;
  readonly service?: string;
}

export function createLogger(options: LoggerOptions, destination?: DestinationStream): AppLogger {
  return pino(
    {
      level: options.level,
      base: { service: options.service ?? 'wagering-processor' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      mixin: () => ({ ...currentLogContext() }),
      redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
    },
    destination,
  );
}
