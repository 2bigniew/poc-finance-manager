import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({
    type: String,
    minLength: 1,
    description: "Caller's reference for the Invoice.",
    example: 'INV-2026-0001',
  })
  @IsString()
  @IsNotEmpty()
  externalReference!: string;

  @ApiProperty({
    type: String,
    pattern: DECIMAL_AMOUNT_PATTERN.source,
    description:
      'Invoice amount in `currency` as a decimal string (no sign, exponent, or separators). Zero is accepted.',
    example: '100.00',
  })
  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'amount must be a non-negative decimal amount',
  })
  amount!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: CURRENCY_CODE_PATTERN.source,
    description:
      'ISO-4217 code. Non-USD amounts are converted to USD via Frankfurter once, at creation.',
    example: 'EUR',
  })
  @IsString()
  @Length(3, 3)
  @Matches(CURRENCY_CODE_PATTERN, {
    message: 'currency must be a 3-letter ISO-4217 currency code',
  })
  currency!: string;
}
