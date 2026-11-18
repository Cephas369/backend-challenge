import { Module } from '@nestjs/common';
import { WageringController } from './wagering.controller';
import { WalletsController } from './wallets.controller';

@Module({
  controllers: [WalletsController, WageringController],
})
export class HttpApiModule {}
