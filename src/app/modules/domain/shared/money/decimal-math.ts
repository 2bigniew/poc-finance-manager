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
