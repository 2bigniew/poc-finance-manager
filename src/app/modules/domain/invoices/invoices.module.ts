import { Module } from '@nestjs/common';
import { CurrencyExchangeModule } from '@app/modules/domain/shared/money/currency-exchange.module';
import { InvoicesController } from './invoices.controller';
import { InvoicesRepository } from './invoices.repository';
import { InvoicesService } from './invoices.service';

@Module({
  imports: [CurrencyExchangeModule],
  controllers: [InvoicesController],
  providers: [InvoicesRepository, InvoicesService],
  // InvoicesRepository stays private; other modules (e.g. the upcoming Reservations
  // module) coordinate through InvoicesService (ARCHITECTURE.md).
  exports: [InvoicesService],
})
export class InvoicesModule {}
