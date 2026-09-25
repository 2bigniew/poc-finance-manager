import { ApiProperty } from '@nestjs/swagger';
import { Money } from '../money';

// OpenAPI schema of the Money wire shape. Response DTOs still carry the domain `Money`
// value as-is (it already is the plain {amount, currency} JSON shape) - this class only
// describes it, so amounts are documented as exact decimal strings, never as numbers.
export class MoneyDto implements Money {
  @ApiProperty({
    type: String,
    description:
      'Exact decimal amount as a string (never a JSON number) so no floating-point precision is lost.',
    example: '1234.5600',
    pattern: '^\\d+(\\.\\d+)?$',
  })
  readonly amount!: string;

  @ApiProperty({
    type: String,
    description: 'ISO-4217 currency code.',
    example: 'USD',
    pattern: '^[A-Z]{3}$',
  })
  readonly currency!: string;
}
