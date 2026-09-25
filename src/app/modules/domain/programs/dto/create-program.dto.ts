import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({
    type: String,
    minLength: 1,
    example: 'Supplier Finance Program 2026',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    type: String,
    pattern: DECIMAL_AMOUNT_PATTERN.source,
    description:
      'Capacity as originally agreed, in originalCapacityCurrency. Non-negative decimal string (no sign, exponent, or separators). Reference value only - it does not drive capacity.',
    example: '1000.00',
  })
  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'originalCapacityAmount must be a non-negative decimal amount',
  })
  originalCapacityAmount!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: CURRENCY_CODE_PATTERN.source,
    description: 'ISO-4217 code of originalCapacityAmount.',
    example: 'USD',
  })
  @IsString()
  @Length(3, 3)
  @Matches(CURRENCY_CODE_PATTERN, {
    message:
      'originalCapacityCurrency must be a 3-letter ISO-4217 currency code',
  })
  originalCapacityCurrency!: string;

  @ApiProperty({
    type: String,
    pattern: DECIMAL_AMOUNT_PATTERN.source,
    description:
      'Initial treasury-owned total capacity in USD (decimal string). Afterwards it changes only through Kafka treasury reconciliation.',
    example: '1000.00',
  })
  @IsString()
  @Matches(DECIMAL_AMOUNT_PATTERN, {
    message: 'totalCapacityUsdAmount must be a non-negative decimal amount',
  })
  totalCapacityUsdAmount!: string;
}
