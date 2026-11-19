import { type DynamicModule, Module } from '@nestjs/common';
import type { AppConfig } from './infrastructure/config/config';
import { CoreModule } from './infrastructure/core.module';
import type { AppLogger } from './infrastructure/observability/logger';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { SqsModule } from './infrastructure/sqs/sqs.module';
import { HealthModule } from './interfaces/http/health/health.module';
import { HttpApiModule } from './interfaces/http/http-api.module';
import { MessagingModule } from './interfaces/messaging/messaging.module';
import { UseCasesModule } from './use-cases.module';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, logger: AppLogger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config, logger),
        PersistenceModule.forRoot(),
        SqsModule.forRoot(),
        UseCasesModule,
        HealthModule,
        MessagingModule.forRoot(),
        // health fica no ar em todos os papéis; a API de negócio só no papel "api"
        ...(config.roles.has('api') ? [HttpApiModule] : []),
      ],
    };
  }
}
