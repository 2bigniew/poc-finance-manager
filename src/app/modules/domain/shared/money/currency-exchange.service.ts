import { Injectable, Logger } from '@nestjs/common';
import { FrankfurterClient } from './clients/frankfurter.client';
import { isNonNegativeDecimalString, multiplyDecimal } from './decimal-math';
import { InvalidMoneyAmountError } from './exceptions/invalid-money-amount.error';
import { UnsupportedCurrencyError } from './exceptions/unsupported-currency.error';
import { Money } from './money';
import { MoneyConversion } from './money-conversion';

const USD = 'USD';
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
// Matches the NUMERIC(19,4) precision already established for every money column
// (see the programs/invoices migrations) - the "existing Money implementation" this
// project has settled on, rather than a separate per-currency minor-unit table.
const USD_DECIMAL_SCALE = 4;

@Injectable()
export class CurrencyExchangeService {
  private readonly logger = new Logger(CurrencyExchangeService.name);

  constructor(private readonly frankfurterClient: FrankfurterClient) {}

  async convertToUsd(money: Money): Promise<MoneyConversion> {
    const currency = this.assertSupportedCurrencyFormat(money.currency);
    this.assertValidAmount(money.amount);

    if (currency === USD) {
      // No Frankfurter call for USD -> USD (CLAUDE.md section 8): rate is trivially 1,
      // and the conversion snapshot uses the current operation date since there is no
      // provider rate date to record for an identity conversion.
      return {
        original: money,
        converted: money,
        rate: '1',
        rateDate: new Date(),
        source: 'frankfurter.dev',
      };
    }

    const rate = await this.frankfurterClient.getRate(currency, USD);
    const convertedAmount = multiplyDecimal(
      money.amount,
      rate.rate,
      USD_DECIMAL_SCALE,
    );

    this.logger.log(
      `Converted ${currency} to USD using rate dated ${rate.rateDate.toISOString()}`,
    );

    return {
      original: money,
      converted: { amount: convertedAmount, currency: USD },
      rate: rate.rate,
      rateDate: rate.rateDate,
      source: 'frankfurter.dev',
    };
  }

  private assertSupportedCurrencyFormat(currency: string): string {
    const normalized = currency.trim().toUpperCase();
    if (!CURRENCY_CODE_PATTERN.test(normalized)) {
      throw new UnsupportedCurrencyError(currency);
    }

    return normalized;
  }

  private assertValidAmount(amount: string): void {
    if (!isNonNegativeDecimalString(amount)) {
      throw new InvalidMoneyAmountError(amount);
    }
  }
}
