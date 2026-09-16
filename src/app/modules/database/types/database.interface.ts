import { InvoicesTable } from './tables/invoices.table';
import { OutboxEventsTable } from './tables/outbox-events.table';
import { ProgramsTable } from './tables/programs.table';
import { ReconciliationEventsTable } from './tables/reconciliation-events.table';
import { ReconciliationsTable } from './tables/reconciliations.table';
import { ReleaseEventsTable } from './tables/release-events.table';
import { ReleasesTable } from './tables/releases.table';
import { ReservationEventsTable } from './tables/reservation-events.table';
import { ReservationsTable } from './tables/reservations.table';
import { RefreshTokensTable } from './tables/refresh-tokens.table';
import { UsersTable } from './tables/users.table';

export interface Database {
  users: UsersTable;
  refreshTokens: RefreshTokensTable;

  programs: ProgramsTable;
  invoices: InvoicesTable;
  reservations: ReservationsTable;
  releases: ReleasesTable;
  reconciliations: ReconciliationsTable;

  reservationEvents: ReservationEventsTable;
  releaseEvents: ReleaseEventsTable;
  reconciliationEvents: ReconciliationEventsTable;

  outboxEvents: OutboxEventsTable;
}
