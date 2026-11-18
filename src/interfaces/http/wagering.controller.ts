import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { GetWagerTransaction } from '../../application/wagering/wager-transaction-queries';
import { addToLogContext } from '../../infrastructure/observability/log-context';
import type { AppLogger } from '../../infrastructure/observability/logger';
import { LOGGER } from '../../infrastructure/tokens';
import { idempotencyKeyContract, opaqueId, wagerTransactionContract } from '../contracts/wager-contracts';
import { currentCorrelationId } from './correlation-id.middleware';
import { parseMoney, parseRequest, RequestValidationError } from './request-validation';
import { httpStatusFor, transactionResponse, transactionResultResponse } from './views';

@Controller()
export class WageringController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransaction,
    private readonly transactions: GetWagerTransaction,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  /**
   * 201 processada, 202 aguardando referência, 422 rejeitada por regra de negócio.
   * Um replay devolve o mesmo status e o mesmo corpo, com `idempotentReplay: true`.
   */
  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (idempotencyKey === undefined) {
      throw new RequestValidationError('IDEMPOTENCY_KEY_REQUIRED', 'o header Idempotency-Key é obrigatório', [
        { path: 'Idempotency-Key', message: 'obrigatório' },
      ]);
    }
    const key = parseRequest(idempotencyKeyContract, idempotencyKey, 'Idempotency-Key');
    const input = parseRequest(wagerTransactionContract, body, 'corpo');
    addToLogContext({ providerId: input.providerId, walletId: input.walletId });

    const result = await this.submitTransaction.execute({
      ...input,
      money: parseMoney(input.money, 'money'),
      idempotencyKey: key,
      correlationId: currentCorrelationId(),
    });

    addToLogContext({ transactionId: result.transactionId });
    this.logger.info(
      {
        kind: input.kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      },
      'wager transaction submitted',
    );
    response.status(httpStatusFor(result.status));
    if (result.idempotentReplay) {
      response.setHeader('Idempotent-Replayed', 'true');
    }
    return transactionResultResponse(result);
  }

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    const id = parseRequest(z.uuid(), transactionId, 'transactionId');
    return transactionResponse(await this.transactions.byId(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    return transactionResponse(
      await this.transactions.byExternalId(
        parseRequest(opaqueId(64), providerId, 'providerId'),
        parseRequest(opaqueId(255), externalTransactionId, 'externalTransactionId'),
      ),
    );
  }
}
