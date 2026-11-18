import { Global, Module } from '@nestjs/common';
import type { UnitOfWork } from './application/ports/persistence';
import type { Clock, IdGenerator } from './application/ports/runtime';
import { SubmitWagerTransaction } from './application/wagering/submit-wager-transaction';
import { GetWagerTransaction } from './application/wagering/wager-transaction-queries';
import { CreateWallet } from './application/wallets/create-wallet';
import { GetWallet, ListLedger, ReconcileWallet } from './application/wallets/wallet-queries';
import { ReferenceRetryPolicy } from './domain/wagering/reference-retry-policy';
import { WagerSettlement } from './domain/wagering/wager-settlement';
import { systemClock, uuidV7Generator } from './infrastructure/runtime';
import { CLOCK, ID_GENERATOR, UNIT_OF_WORK } from './infrastructure/tokens';

/**
 * Raiz de composição dos use cases. Eles são classes simples (sem Nest): este módulo só
 * os monta com as portas concretas e os disponibiliza para HTTP e SQS.
 */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    { provide: ID_GENERATOR, useValue: uuidV7Generator },
    { provide: WagerSettlement, useFactory: () => new WagerSettlement(new ReferenceRetryPolicy()) },
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (unitOfWork: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new CreateWallet(unitOfWork, clock, ids),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWallet(unitOfWork),
    },
    {
      provide: ListLedger,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new ListLedger(unitOfWork),
    },
    {
      provide: ReconcileWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new ReconcileWallet(unitOfWork),
    },
    {
      provide: SubmitWagerTransaction,
      inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, ID_GENERATOR],
      useFactory: (unitOfWork: UnitOfWork, settlement: WagerSettlement, clock: Clock, ids: IdGenerator) =>
        new SubmitWagerTransaction(unitOfWork, settlement, clock, ids),
    },
    {
      provide: GetWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork) => new GetWagerTransaction(unitOfWork),
    },
  ],
  exports: [
    CLOCK,
    ID_GENERATOR,
    WagerSettlement,
    CreateWallet,
    GetWallet,
    ListLedger,
    ReconcileWallet,
    SubmitWagerTransaction,
    GetWagerTransaction,
  ],
})
export class UseCasesModule {}
