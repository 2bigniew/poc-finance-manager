// Minimal placeholder for BUSINESS.md's Money value object: an immutable amount+currency
// pair, always an exact decimal string - never a JavaScript number/float.
//
// Program only ever stores and returns Money; it performs no arithmetic on it. The full
// Martin Fowler Money pattern BUSINESS.md describes (add/subtract/compare,
// currency-mismatch rejection, minor-unit rounding) is intentionally deferred until
// Invoices/Reservations/Releases actually need it (CLAUDE.md: "Do not add future-facing
// abstractions unless the current implementation actually needs them").
export interface Money {
  readonly amount: string;
  readonly currency: string;
}
