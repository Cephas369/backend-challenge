export interface WaitOptions {
  readonly description: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Espera uma condição observável em vez de dormir um tempo fixo: o teste termina assim
 * que a condição vale e falha com uma mensagem clara quando o prazo estoura.
 */
export async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: WaitOptions,
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(options.intervalMs ?? 50);
  }
  throw new Error(`tempo esgotado esperando: ${options.description}`, { cause: lastError });
}

/** Promessa liberada de fora: coordena operações concorrentes sem `sleep`. */
export function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
