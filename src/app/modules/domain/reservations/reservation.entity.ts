import { Money } from '@app/modules/domain/shared/money/money';
import { MoneyConversion } from '@app/modules/domain/shared/money/money-conversion';

// Redefined independently of ReservationsTable's ReservationStatus (database/types)
// rather than imported from it - domain entities do not depend on persistence types;
// repositories own that mapping direction (ARCHITECTURE.md).
export const RESERVATION_STATUSES = ['ACTIVE', 'RELEASED'] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface Reservation {
  id: string;
  programId: string;
  invoiceId: string;

  // The Reservation's OWN FX snapshot, taken at reservation time - never the Invoice's
  // stored conversion (BUSINESS.md: "Reservation MUST keep the FX rate used at
  // reservation time"; CLAUDE.md section 2/3: the Reservation's stored conversion, not
  // Invoice's, is authoritative for capacity consumption and future Release).
  originalMoney: Money;
  convertedMoneyUsd: Money;
  conversion: MoneyConversion;

  status: ReservationStatus;

  createdByUserId: string;

  createdAt: Date;
  updatedAt: Date;
}
