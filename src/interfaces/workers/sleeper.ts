/** Espera que pode ser interrompida (usada para parar workers sem aguardar o intervalo inteiro). */
export class Sleeper {
  private wake: (() => void) | undefined;

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.wake = done;
    });
  }

  interrupt(): void {
    this.wake?.();
  }
}
