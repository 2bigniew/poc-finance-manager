import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

// Non-negative plain decimal only - no sign, no exponent, no thousands separators.
// Decimal-string input (not a JSON number) avoids ever parsing e.g. "1234.56" through
// unsafe JS float precision (CLAUDE.md Money Input Format).
const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

// id, convertedMoneyUsd/conversionRate/conversionRateDate/conversionSource, status, and
// createdByUserId are all application-owned (CLAUDE.md section 16) - none of them are
// accepted here. status is always OPEN on creation; createdByUserId comes from
// @CurrentUser(), never client input.
export class CreateInvoiceDto {
  @IsString()
  @IsNotEmpty()
  externalReference!: string;

  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'amount must be a non-negative decimal amount',
  })
  amount!: string;

  @IsString()
  @Length(3, 3)
  @Matches(CURRENCY_CODE_PATTERN, {
    message: 'currency must be a 3-letter ISO-4217 currency code',
  })
  currency!: string;
}
