import { isNonNegativeDecimalString, multiplyDecimal } from './decimal-math';

describe('isNonNegativeDecimalString', () => {
  it.each(['0', '0.10', '1234567.89', '100', '4.123456'])(
    'accepts %s',
    (value) => {
      expect(isNonNegativeDecimalString(value)).toBe(true);
    },
  );

  it.each(['-1', '-0.10', 'abc', '1e10', 'NaN', 'Infinity', '', '1.2.3', ' 1'])(
    'rejects %s',
    (value) => {
      expect(isNonNegativeDecimalString(value)).toBe(false);
    },
  );
});

describe('multiplyDecimal', () => {
  it('multiplies two whole numbers', () => {
    expect(multiplyDecimal('100', '2', 4)).toBe('200.0000');
  });

  it('multiplies exactly, matching hand-computed decimal arithmetic', () => {
    // 100.00 * 1.0834 = 108.3400 exactly - never routed through JS floating point.
    expect(multiplyDecimal('100.00', '1.0834', 4)).toBe('108.3400');
  });

  it('rounds half-up when truncating extra scale', () => {
    // 1.00 * 0.12345 = 0.12345 -> rounds to 0.1235 at scale 4 (half-up on the 5th digit)
    expect(multiplyDecimal('1.00', '0.12345', 4)).toBe('0.1235');
  });

  it('rounds down when the dropped digits are below half', () => {
    expect(multiplyDecimal('1.00', '0.12344', 4)).toBe('0.1234');
  });

  it('pads with trailing zeros when the exact product has fewer decimals than scale', () => {
    expect(multiplyDecimal('2', '3', 4)).toBe('6.0000');
  });

  it('handles the classic 0.1 + 0.2-style precision trap correctly for multiplication', () => {
    // 0.1 * 0.2 = 0.02 exactly; naive `0.1 * 0.2` in JS float is 0.020000000000000004.
    expect(multiplyDecimal('0.1', '0.2', 4)).toBe('0.0200');
  });

  it('produces exact results for large amounts', () => {
    expect(multiplyDecimal('1234567.89', '1', 4)).toBe('1234567.8900');
  });

  it('returns zero when either operand is zero', () => {
    expect(multiplyDecimal('0', '1.5', 4)).toBe('0.0000');
  });
});
