import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { ProviderIdentity, ProviderIdentityPort } from '../../application/ports/provider-identity';
import { PROVIDER_IDENTITY } from '../../infrastructure/tokens';

declare module 'express' {
  interface Request {
    providerIdentity?: ProviderIdentity | 'anonymous';
  }
}

/**
 * Guard das rotas de transação. Hoje é um no-op (a porta padrão devolve `anonymous`). Com um IdP, a
 * porta valida o token e lança `ProviderAuthenticationError` (401) antes de qualquer validação do pedido.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    request.providerIdentity = await this.identities.identify(request.headers);
    return true;
  }
}

/** O provedor autenticado tentou operar em nome de outro provedor. */
export class ProviderMismatchError extends Error {
  readonly code = 'PROVIDER_MISMATCH';

  constructor() {
    super('o provedor autenticado não corresponde ao providerId do pedido');
    this.name = 'ProviderMismatchError';
  }
}

/**
 * Um provedor autenticado só opera em nome de si mesmo; sem IdP (`anonymous`), vale o payload.
 * Sem identidade resolvida (rota sem o guard), recusa: o erro de configuração falha fechado.
 */
export function actsOnBehalfOf(
  identity: ProviderIdentity | 'anonymous' | undefined,
  providerId: string,
): boolean {
  if (identity === undefined) {
    return false;
  }
  return identity === 'anonymous' || identity.providerId === providerId;
}
