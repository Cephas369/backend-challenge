import type { NextFunction, Request, Response } from 'express';
import { runWithLogContext } from '../../infrastructure/observability/log-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Aceita o id do cliente só se for curto e seguro para log; senão gera um novo. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function correlationIdMiddleware(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.header(CORRELATION_ID_HEADER);
  const correlationId =
    incoming !== undefined && SAFE_CORRELATION_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
  response.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithLogContext({ correlationId }, next);
}
