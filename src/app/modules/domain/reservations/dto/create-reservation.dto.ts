import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

// No monetary input at all: the amount/currency come from the Invoice, and
// status/createdByUserId/FX values are all application-owned (CLAUDE.md section 34).
export class CreateReservationDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'OPEN Invoice to reserve against the Program.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  invoiceId!: string;
}
