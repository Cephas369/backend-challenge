import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação que acompanham todo log emitido dentro de um fluxo. */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Executa `fn` com um contexto de log herdando os campos do contexto atual. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...context }, fn);
}

/** Acrescenta campos ao contexto corrente (ex.: walletId descoberto no meio do fluxo). */
export function addToLogContext(fields: LogContext): void {
  const current = storage.getStore();
  if (current) {
    Object.assign(current, fields);
  }
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}
