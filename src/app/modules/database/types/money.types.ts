// Decimal-safe persistence types for monetary/FX values - backed by PostgreSQL NUMERIC,
// never JavaScript floating point. See BUSINESS.md Money/Currency Exchange sections.
export type DecimalAmount = string;
export type CurrencyCode = string;
export type FxRate = DecimalAmount;

// Only Frankfurter is a supported conversion source today; widen intentionally when a
// second source is introduced so unhandled sources fail to compile.
export type ConversionSource = 'frankfurter.dev';
