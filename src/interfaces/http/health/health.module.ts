import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { ReadinessService } from './readiness.service';

/** Health checks e métricas: no ar em todos os papéis, sem autenticação. */
@Module({
  controllers: [HealthController, MetricsController],
  providers: [ReadinessService],
})
export class HealthModule {}
