import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

// Non-negative plain decimal only - no sign, no exponent, no thousands separators.
// Business-invariant enforcement (>= 0) is repeated in ProgramsService; this is just
// input-format validation at the HTTP boundary.
const DECIMAL_AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

// treasuryVersion/totalCapacityUsd currency are never accepted from client input:
// treasuryVersion is treasury-owned state (initialized by the service, see
// ProgramsService.create), and capacity is always USD by definition (BUSINESS.md).
export class CreateProgramDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'originalCapacityAmount must be a non-negative decimal amount',
  })
  originalCapacityAmount!: string;

  @IsString()
  @Length(3, 3)
  @Matches(CURRENCY_CODE_PATTERN, {
    message:
      'originalCapacityCurrency must be a 3-letter ISO-4217 currency code',
  })
  originalCapacityCurrency!: string;

  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'totalCapacityUsdAmount must be a non-negative decimal amount',
  })
  totalCapacityUsdAmount!: string;
}
