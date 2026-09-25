// Exact decimal-string comparison for assertions. Never parses amounts through a JS
// number, so "1000", "1000.0000" and "1000.00" compare equal without float error.

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;
const COMPARISON_SCALE = 12;

function toScaled(value: string, scale: number): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`"${value}" is not a plain decimal string`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '0', fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > scale) {
    throw new Error(`"${value}" exceeds comparison scale ${scale}`);
  }
  const scaled = BigInt(integerPart + fractionPart.padEnd(scale, '0'));
  return negative ? -scaled : scaled;
}

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

export function decimalEquals(actual: unknown, expected: string): boolean {
  return (
    isDecimalString(actual) &&
    toScaled(actual, COMPARISON_SCALE) === toScaled(expected, COMPARISON_SCALE)
  );
}

export function decimalGreaterThan(
  actual: unknown,
  threshold: string,
): boolean {
  return (
    isDecimalString(actual) &&
    toScaled(actual, COMPARISON_SCALE) > toScaled(threshold, COMPARISON_SCALE)
  );
}

// |actual - a*b| <= tolerance, computed exactly with BigInt.
export function productWithin(
  actual: string,
  a: string,
  b: string,
  tolerance: string,
): boolean {
  const factorScale = 10;
  const productScale = factorScale * 2;
  const product = toScaled(a, factorScale) * toScaled(b, factorScale);
  const diff = toScaled(actual, productScale) - product;
  const absDiff = diff < 0n ? -diff : diff;
  return absDiff <= toScaled(tolerance, productScale);
}
