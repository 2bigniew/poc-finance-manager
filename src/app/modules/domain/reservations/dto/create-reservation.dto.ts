import { IsUUID } from 'class-validator';

// No monetary input at all: the amount/currency come from the Invoice, and
// status/createdByUserId/FX values are all application-owned (CLAUDE.md section 34).
export class CreateReservationDto {
  @IsUUID()
  invoiceId!: string;
}
