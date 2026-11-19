/** Estado do ciclo de vida do processo: o readiness deixa de responder "ok" ao começar o shutdown. */
export class LifecycleState {
  private shuttingDown = false;

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  markShuttingDown(): void {
    this.shuttingDown = true;
  }
}
