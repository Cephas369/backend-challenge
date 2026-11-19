import { ApplicationError } from '../errors';

/** Provedor autenticado que fez o pedido. */
export interface ProviderIdentity {
  readonly providerId: string;
}

/**
 * Ponto de extensão da autenticação (seção 2). Hoje não há IdP integrado: a implementação padrão
 * devolve `anonymous` e a identidade vem do payload. Com um IdP, a implementação valida o token do
 * provedor e devolve o `providerId` dele, ou lança `ProviderAuthenticationError` quando o token falta
 * ou é inválido. Só a implementação sem autenticação devolve `anonymous`.
 */
export interface ProviderIdentityPort {
  identify(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<ProviderIdentity | 'anonymous'>;
}

/** Credencial ausente, expirada ou inválida (401). */
export class ProviderAuthenticationError extends ApplicationError {
  override readonly code = 'UNAUTHENTICATED';
}

/** Implementação sem autenticação: a API confia na rede (decisão D26 do ARCHITECTURE.md). */
export const anonymousProviders: ProviderIdentityPort = {
  identify: async () => 'anonymous',
};
