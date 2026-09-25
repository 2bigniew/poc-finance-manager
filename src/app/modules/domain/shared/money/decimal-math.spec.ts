import {
  compareDecimalStrings,
  isNonNegativeDecimalString,
  multiplyDecimal,
  subtractDecimal,
} from './decimal-math';

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

describe('subtractDecimal', () => {
  it('subtracts exactly', () => {
    expect(subtractDecimal('100', '20', 4)).toBe('80.0000');
  });

  it('computes the exact-boundary case (total - reserved = 0)', () => {
    expect(subtractDecimal('100.0000', '100.0000', 4)).toBe('0.0000');
  });

  it('handles differing input scales', () => {
    expect(subtractDecimal('100.5', '0.25', 4)).toBe('100.2500');
  });

  it('avoids floating-point drift for the classic 0.3 - 0.2 case', () => {
    // 0.3 - 0.2 = 0.1 exactly; naive JS float (0.3 - 0.2) is 0.09999999999999998.
    expect(subtractDecimal('0.3', '0.2', 4)).toBe('0.1000');
  });

  it('throws RangeError when the result would be negative', () => {
    expect(() => subtractDecimal('20', '100', 4)).toThrow(RangeError);
  });

  it('returns zero when both operands are equal to zero', () => {
    expect(subtractDecimal('0', '0', 4)).toBe('0.0000');
  });
});

describe('compareDecimalStrings', () => {
  it('returns -1 when a < b', () => {
    expect(compareDecimalStrings('79.99', '80')).toBe(-1);
  });

  it('returns 1 when a > b', () => {
    expect(compareDecimalStrings('80.01', '80')).toBe(1);
  });

  it('returns 0 for the exact-boundary case', () => {
    expect(compareDecimalStrings('80', '80.00')).toBe(0);
  });

  it('compares correctly across differing scales', () => {
    expect(compareDecimalStrings('1', '0.9999')).toBe(1);
    expect(compareDecimalStrings('0.9999', '1')).toBe(-1);
  });

  it('treats differently-formatted zeros as equal', () => {
    expect(compareDecimalStrings('0', '0.0000')).toBe(0);
  });
});
