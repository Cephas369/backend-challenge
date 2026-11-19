import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrometheusMetrics } from '../../../infrastructure/observability/metrics';

/** Métricas no formato texto do Prometheus. Aberto, como os health checks. */
@Controller()
export class MetricsController {
  constructor(private readonly metrics: PrometheusMetrics) {}

  @Get('metrics')
  async scrape(@Res() response: Response): Promise<void> {
    response.type(this.metrics.registry.contentType).send(await this.metrics.render());
  }
}
