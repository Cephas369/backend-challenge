import type { LoggerService } from '@nestjs/common';
import type { Level } from 'pino';
import type { AppLogger } from './logger';

const STACK_TRACE = /\n\s+at /;

/** Encaminha os logs internos do Nest para o pino, mantendo o formato JSON único. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  private write(level: Level, message: unknown, params: unknown[]): void {
    const fields: Record<string, unknown> = {};
    const rest = [...params];
    const last = rest.at(-1);
    if (typeof last === 'string' && !STACK_TRACE.test(last)) {
      fields.context = last;
      rest.pop();
    }
    const stack = rest.find((param): param is string => typeof param === 'string' && STACK_TRACE.test(param));
    if (stack) {
      fields.stack = stack;
    }

    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, ...message });
    } else {
      this.logger[level](fields, String(message));
    }
  }
}
