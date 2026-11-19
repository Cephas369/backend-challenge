import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CreateWallet } from '../../application/wallets/create-wallet';
import { GetWallet, ListLedger, ReconcileWallet } from '../../application/wallets/wallet-queries';
import { addToLogContext } from '../../infrastructure/observability/log-context';
import type { AppLogger } from '../../infrastructure/observability/logger';
import { PrometheusMetrics } from '../../infrastructure/observability/metrics';
import { LOGGER } from '../../infrastructure/tokens';
import { createWalletContract, ledgerQueryContract } from '../contracts/wager-contracts';
import { currentCorrelationId } from './correlation-id.middleware';
import { decodeLedgerCursor, encodeLedgerCursor, parseMoney, parseRequest } from './request-validation';
import { ledgerEntryResponse, reconciliationResponse, walletResponse } from './views';

const walletIdParam = z.uuid();

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly getWallet: GetWallet,
    private readonly listLedger: ListLedger,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly metrics: PrometheusMetrics,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseRequest(createWalletContract, body, 'corpo');
    const wallet = await this.createWallet.execute({
      playerId: input.playerId,
      initialBalance: parseMoney(input.initialBalance, 'initialBalance'),
      correlationId: currentCorrelationId(),
    });
    addToLogContext({ walletId: wallet.id });
    this.logger.info('wallet created');
    return walletResponse(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletResponse(await this.getWallet.execute(parseRequest(walletIdParam, walletId, 'walletId')));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const { cursor, limit } = parseRequest(ledgerQueryContract, query, 'query');
    const page = await this.listLedger.execute({
      walletId: parseRequest(walletIdParam, walletId, 'walletId'),
      beforeVersion: cursor === undefined ? undefined : decodeLedgerCursor(cursor),
      limit,
    });
    return {
      items: page.entries.map(ledgerEntryResponse),
      nextCursor: page.nextBeforeVersion === undefined ? null : encodeLedgerCursor(page.nextBeforeVersion),
    };
  }

  /** Confere o saldo contra o ledger. Divergência é logada e sinalizada, nunca corrigida. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const report = await this.reconcileWallet.execute(parseRequest(walletIdParam, walletId, 'walletId'));
    addToLogContext({ walletId: report.walletId });
    if (report.consistent) {
      this.logger.info({ checkedEntries: report.checkedEntries }, 'wallet reconciled');
    } else {
      this.metrics.reconciliationMismatch();
      this.logger.error(
        { checkedEntries: report.checkedEntries, issues: report.issues },
        'reconciliation mismatch',
      );
    }
    return reconciliationResponse(report);
  }
}
