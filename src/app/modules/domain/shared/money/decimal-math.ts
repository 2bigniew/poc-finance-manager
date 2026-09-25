// Exact decimal arithmetic for money/FX calculations, using only native BigInt - never
// JavaScript floating point (BUSINESS.md: "Floating-point types MUST NOT be used for
// monetary calculations"). No third-party decimal library exists in this project yet;
// the only operation actually needed right now is "multiply two non-negative decimal
// strings and round to a fixed scale", so this stays a small, self-contained utility
// rather than pulling in a general-purpose decimal library for one operation.
//
// Callers are responsible for ensuring both inputs are well-formed non-negative decimal
// strings (e.g. via the same regex used for DTO validation) - this module does not
// re-validate format, only computes.

const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

// Matches the NUMERIC(19,4) precision already established for every money column in the
// schema (programs/invoices/reservations migrations) - the "existing Money
// implementation" this project has settled on, rather than a separate per-currency
// minor-unit table.
export const USD_DECIMAL_SCALE = 4;

export function isNonNegativeDecimalString(value: string): boolean {
  return DECIMAL_STRING_PATTERN.test(value);
}

// Multiplies two exact non-negative decimal strings and rounds the result to `scale`
// decimal places using half-up rounding.
export function multiplyDecimal(a: string, b: string, scale: number): string {
  const [aDigits, aScale] = toDigitsWithScale(a);
  const [bDigits, bScale] = toDigitsWithScale(b);

  const product = aDigits * bDigits;
  const productScale = aScale + bScale;

  return scaleBigIntToString(product, productScale, scale);
}

// Subtracts two exact non-negative decimal strings (a - b) and rounds to `scale` decimal
// places. Throws RangeError if the result would be negative: for this project's only use
// (available capacity = total - reserved), a negative result means the oversubscription
// invariant was already violated elsewhere, which is a bug worth surfacing loudly rather
// than silently clamping to zero.
export function subtractDecimal(a: string, b: string, scale: number): string {
  const [aDigits, aScale] = toDigitsWithScale(a);
  const [bDigits, bScale] = toDigitsWithScale(b);
  const commonScale = Math.max(aScale, bScale, scale);

  const aScaled = aDigits * 10n ** BigInt(commonScale - aScale);
  const bScaled = bDigits * 10n ** BigInt(commonScale - bScale);
  const difference = aScaled - bScaled;

  if (difference < 0n) {
    throw new RangeError(
      `subtractDecimal: result of ${a} - ${b} would be negative`,
    );
  }

  return scaleBigIntToString(difference, commonScale, scale);
}

// Compares two exact non-negative decimal strings without ever converting either to a
// JavaScript number. Returns -1 if a < b, 0 if equal, 1 if a > b.
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const [aDigits, aScale] = toDigitsWithScale(a);
  const [bDigits, bScale] = toDigitsWithScale(b);
  const commonScale = Math.max(aScale, bScale);

  const aScaled = aDigits * 10n ** BigInt(commonScale - aScale);
  const bScaled = bDigits * 10n ** BigInt(commonScale - bScale);

  if (aScaled < bScaled) {
    return -1;
  }
  if (aScaled > bScaled) {
    return 1;
  }
  return 0;
}

function toDigitsWithScale(value: string): [bigint, number] {
  const [wholePart, fractionPart = ''] = value.split('.');
  return [BigInt(`${wholePart}${fractionPart}`), fractionPart.length];
}

function scaleBigIntToString(
  value: bigint,
  fromScale: number,
  toScale: number,
): string {
  if (fromScale === toScale) {
    return formatBigIntWithScale(value, toScale);
  }

  if (fromScale < toScale) {
    return formatBigIntWithScale(
      value * 10n ** BigInt(toScale - fromScale),
      toScale,
    );
  }

  const divisor = 10n ** BigInt(fromScale - toScale);
  const half = divisor / 2n;
  const rounded = (value + half) / divisor;
  return formatBigIntWithScale(rounded, toScale);
}

function formatBigIntWithScale(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  const wholePart = digits.slice(0, digits.length - scale) || '0';
  const fractionPart = scale > 0 ? digits.slice(digits.length - scale) : '';

  return fractionPart ? `${wholePart}.${fractionPart}` : wholePart;
}
