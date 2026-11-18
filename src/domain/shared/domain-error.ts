/** Erro de domínio com código estável e legível por máquina. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invariante que só quebra por erro de programação, nunca por entrada de um provedor. */
export class DomainInvariantError extends DomainError {
  override readonly code = 'DOMAIN_INVARIANT_VIOLATION';
}
