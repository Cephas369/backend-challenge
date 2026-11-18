import type { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/persistence';
import { type WalletView, walletViewOf } from './create-wallet';

export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.unitOfWork.readOnly(({ wallets }) => wallets.findById(walletId));
    if (wallet === undefined) {
      throw new WalletNotFoundError(walletId);
    }
    return walletViewOf(wallet);
  }
}

export interface LedgerPageQuery {
  readonly walletId: string;
  /** Continua a partir daqui (exclusivo); ausente na primeira página. */
  readonly beforeVersion?: number | undefined;
  readonly limit: number;
}

export interface LedgerPageResult {
  readonly entries: readonly WalletLedgerEntry[];
  /** Onde a próxima página começa; ausente quando acabou. */
  readonly nextBeforeVersion: number | undefined;
}

/** Ledger do mais recente ao mais antigo, com cursor estável pela versão (o ledger é imutável). */
export class ListLedger {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: LedgerPageQuery): Promise<LedgerPageResult> {
    return this.unitOfWork.readOnly(async ({ wallets, ledger }) => {
      if ((await wallets.findById(query.walletId)) === undefined) {
        throw new WalletNotFoundError(query.walletId);
      }
      // um a mais para saber se existe próxima página sem outra consulta
      const entries = await ledger.page(query.walletId, {
        beforeVersion: query.beforeVersion,
        limit: query.limit + 1,
      });
      const page = entries.slice(0, query.limit);
      return {
        entries: page,
        nextBeforeVersion: entries.length > query.limit ? page.at(-1)?.walletVersion : undefined,
      };
    });
  }
}

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  /** Motivos legíveis de cada divergência; vazio quando está consistente. */
  readonly issues: readonly string[];
}

/**
 * Confronta o saldo materializado com o saldo reconstruído pelo ledger, num snapshot consistente.
 * Não corrige nada: quem chama registra e sinaliza a divergência.
 */
export class ReconcileWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(walletId: string): Promise<ReconciliationReport> {
    return this.unitOfWork.readOnly(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (wallet === undefined) {
        throw new WalletNotFoundError(walletId);
      }
      const totals = await ledger.totals(walletId, wallet.currency);
      const calculatedBalance = totals.credits.subtract(totals.debits);
      const issues: string[] = [];
      if (!calculatedBalance.equals(wallet.balance)) {
        issues.push('o saldo da wallet difere da soma do ledger');
      }
      const expectedVersion = totals.latestVersion ?? 1;
      if (expectedVersion !== wallet.version) {
        issues.push(
          `a versão da wallet (${wallet.version}) difere da do último lançamento (${expectedVersion})`,
        );
      }
      if (totals.latestBalance !== undefined && !totals.latestBalance.equals(wallet.balance)) {
        issues.push('o saldo da wallet difere do saldo após o último lançamento');
      }
      if (totals.chainBreaks > 0) {
        issues.push(`${totals.chainBreaks} lançamento(s) não continuam o saldo anterior`);
      }
      return {
        walletId,
        storedBalance: wallet.balance,
        calculatedBalance,
        difference: wallet.balance.subtract(calculatedBalance),
        consistent: issues.length === 0,
        checkedEntries: totals.entries,
        issues,
      };
    });
  }
}
