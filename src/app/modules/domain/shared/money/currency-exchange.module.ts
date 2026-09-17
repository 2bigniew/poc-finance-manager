import { Module } from '@nestjs/common';
import { FrankfurterClient } from './clients/frankfurter.client';
import { CurrencyExchangeService } from './currency-exchange.service';

// HttpModule is @Global() (see src/app/modules/http/http.module.ts), so HTTP_CLIENT is
// already available for injection here without importing it explicitly.
@Module({
  providers: [FrankfurterClient, CurrencyExchangeService],
  // FrankfurterClient stays private; other modules depend only on CurrencyExchangeService
  // (ARCHITECTURE.md: ReservationsService -> CurrencyExchangeService -> FrankfurterClient).
  exports: [CurrencyExchangeService],
})
export class CurrencyExchangeModule {}
