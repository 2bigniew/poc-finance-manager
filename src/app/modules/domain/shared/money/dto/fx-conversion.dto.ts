import { ApiProperty } from '@nestjs/swagger';

// Response shape of the FX snapshot stored with an Invoice/Reservation/Release. Shared
// by those response DTOs instead of each declaring its own identical interface.
export class FxConversionDto {
  @ApiProperty({
    type: String,
    description:
      'Historical rate (original currency -> USD) used for this conversion, as an exact decimal string. It is fixed when the conversion is recorded and is NOT the current market rate. USD -> USD always uses rate 1.',
    example: '1.139400',
  })
  rate!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      "Date of the provider's rate, serialized as an ISO timestamp at 00:00:00Z.",
    example: '2026-09-25T00:00:00.000Z',
  })
  rateDate!: Date;

  @ApiProperty({
    type: String,
    enum: ['frankfurter.dev'],
    description: 'Rate provider.',
    example: 'frankfurter.dev',
  })
  source!: string;
}
