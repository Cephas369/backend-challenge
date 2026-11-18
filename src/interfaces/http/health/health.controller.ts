import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { type ReadinessReport, ReadinessService } from './readiness.service';

/** Endpoints de health ficam abertos, sem autenticação (seção 2). */
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Processo vivo: não consulta dependências. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** PostgreSQL e SQS alcançáveis; 503 quando alguma dependência falha. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport> {
    const report = await this.readiness.check();
    response.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
