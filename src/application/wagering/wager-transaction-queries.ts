import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { TransactionNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/persistence';

export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.readOnly(({ transactions }) =>
      transactions.findById(transactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(`transação ${transactionId} não existe`);
    }
    return transaction;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.unitOfWork.readOnly(({ transactions }) =>
      transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (transaction === undefined) {
      throw new TransactionNotFoundError(
        `transação ${externalTransactionId} do provider ${providerId} não existe`,
      );
    }
    return transaction;
  }
}
