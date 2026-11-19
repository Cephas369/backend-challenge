import { type DynamicModule, Module } from '@nestjs/common';
import { anonymousProviders, type ProviderIdentityPort } from '../../application/ports/provider-identity';
import { PROVIDER_IDENTITY } from '../../infrastructure/tokens';
import { ProviderAuthGuard } from './provider-auth.guard';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

@Module({})
export class HttpApiModule {
  /**
   * Ponto de extensão da autenticação: sem argumento, a API não autentica (`anonymousProviders`).
   * Ligar um IdP é passar aqui uma implementação de `ProviderIdentityPort` que valide o token.
   */
  static forRoot(providerIdentity: ProviderIdentityPort = anonymousProviders): DynamicModule {
    return {
      module: HttpApiModule,
      controllers: [WalletsController, WageringController],
      providers: [{ provide: PROVIDER_IDENTITY, useValue: providerIdentity }, ProviderAuthGuard],
    };
  }
}
