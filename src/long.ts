import type { Timestamp } from './timestamp';
import type { EJSONOptions } from './extended_json';
import { isObjectLike } from './parser/utils';

interface LongWASMHelpers {
  /** Gets the high bits of the last operation performed */
  get_high(): number;
  div_u(lowBits: number, highBits: number, lowBitsDivisor: number, highBitsDivisor: number): number;
  div_s(lowBits: number, highBits: number, lowBitsDivisor: number, highBitsDivisor: number): number;
  rem_u(lowBits: number, highBits: number, lowBitsDivisor: number, highBitsDivisor: number): number;
  rem_s(lowBits: number, highBits: number, lowBitsDivisor: number, highBitsDivisor: number): number;
  mul(
    lowBits: number,
    highBits: number,
    lowBitsMultiplier: number,
    highBitsMultiplier: number
  ): number;
}

/**
 * wasm optimizations, to do native i64 multiplication and divide
 */
let wasm: LongWASMHelpers | undefined = undefined;

/* We do not want to have to include DOM types just for this check */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const WebAssembly: any;

try {
  wasm = (new WebAssembly.Instance(
    new WebAssembly.Module(
      // prettier-ignore
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 13, 2, 96, 0, 1, 127, 96, 4, 127, 127, 127, 127, 1, 127, 3, 7, 6, 0, 1, 1, 1, 1, 1, 6, 6, 1, 127, 1, 65, 0, 11, 7, 50, 6, 3, 109, 117, 108, 0, 1, 5, 100, 105, 118, 95, 115, 0, 2, 5, 100, 105, 118, 95, 117, 0, 3, 5, 114, 101, 109, 95, 115, 0, 4, 5, 114, 101, 109, 95, 117, 0, 5, 8, 103, 101, 116, 95, 104, 105, 103, 104, 0, 0, 10, 191, 1, 6, 4, 0, 35, 0, 11, 36, 1, 1, 126, 32, 0, 173, 32, 1, 173, 66, 32, 134, 132, 32, 2, 173, 32, 3, 173, 66, 32, 134, 132, 126, 34, 4, 66, 32, 135, 167, 36, 0, 32, 4, 167, 11, 36, 1, 1, 126, 32, 0, 173, 32, 1, 173, 66, 32, 134, 132, 32, 2, 173, 32, 3, 173, 66, 32, 134, 132, 127, 34, 4, 66, 32, 135, 167, 36, 0, 32, 4, 167, 11, 36, 1, 1, 126, 32, 0, 173, 32, 1, 173, 66, 32, 134, 132, 32, 2, 173, 32, 3, 173, 66, 32, 134, 132, 128, 34, 4, 66, 32, 135, 167, 36, 0, 32, 4, 167, 11, 36, 1, 1, 126, 32, 0, 173, 32, 1, 173, 66, 32, 134, 132, 32, 2, 173, 32, 3, 173, 66, 32, 134, 132, 129, 34, 4, 66, 32, 135, 167, 36, 0, 32, 4, 167, 11, 36, 1, 1, 126, 32, 0, 173, 32, 1, 173, 66, 32, 134, 132, 32, 2, 173, 32, 3, 173, 66, 32, 134, 132, 130, 34, 4, 66, 32, 135, 167, 36, 0, 32, 4, 167, 11])
    ),
    {}
  ).exports as unknown) as LongWASMHelpers;
} catch {
  // no wasm support
}

const TWO_PWR_16_DBL = 1 << 16;
const TWO_PWR_24_DBL = 1 << 24;
const TWO_PWR_32_DBL = TWO_PWR_16_DBL * TWO_PWR_16_DBL;
const TWO_PWR_64_DBL = TWO_PWR_32_DBL * TWO_PWR_32_DBL;
const TWO_PWR_63_DBL = TWO_PWR_64_DBL / 2;

/** A cache of the Long representations of small integer values. */
const INT_CACHE: { [key: number]: Long } = {};

/** A cache of the Long representations of small unsigned integer values. */
const UINT_CACHE: { [key: number]: Long } = {};

/**
 * A class representing a 64-bit integer
 * @remarks
 * The internal representation of a long is the two given signed, 32-bit values.
 * We use 32-bit pieces because these are the size of integers on which
 * Javascript performs bit-operations.  For operations like addition and
 * multiplication, we split each number into 16 bit pieces, which can easily be
 * multiplied within Javascript's floating-point representation without overflow
 * or change in sign.
 * In the algorithms below, we frequently reduce the negative case to the
 * positive case by negating the input(s) and then post-processing the result.
 * Note that we must ALWAYS check specially whether those values are MIN_VALUE
 * (-2^63) because -MIN_VALUE == MIN_VALUE (since 2^63 cannot be represented as
 * a positive number, it overflows back into a negative).  Not handling this
 * case would often result in infinite recursion.
 * Common constant values ZERO, ONE, NEG_ONE, etc. are found as static properties on this class.
 */
export class Long {
  _bsontype!: 'Long';

  /** An indicator used to reliably determine if an object is a Long or not. */
  __isLong__!: true;

  /**
   * The high 32 bits as a signed value.
   */
  high: number;

  /**
   * The low 32 bits as a signed value.
   */
  low: number;

  /**
   * Whether unsigned or not.
   */
  unsigned: boolean;

  /**
   * Constructs a 64 bit two's-complement integer, given its low and high 32 bit values as *signed* integers.
   *  See the from* functions below for more convenient ways of constructing Longs.
   * @param low - The low (signed) 32 bits of the long
   * @param high - The high (signed) 32 bits of the long
   * @param unsigned - Whether unsigned or not, defaults to signed
   */
  constructor(low = 0, high = 0, unsigned?: boolean) {
    this.low = low | 0;
    this.high = high | 0;
    this.unsigned = !!unsigned;

    Object.defineProperty(this, '__isLong__', {
      value: true,
      configurable: false,
      writable: false,
      enumerable: false
    });
  }

  static TWO_PWR_24 = Long.fromInt(TWO_PWR_24_DBL);

  /** Maximum unsigned value. */
  static MAX_UNSIGNED_VALUE = Long.fromBits(0xffffffff | 0, 0xffffffff | 0, true);
  /** Signed zero */
  static ZERO = Long.fromInt(0);
  /** Unsigned zero. */
  static UZERO = Long.fromInt(0, true);
  /** Signed one. */
  static ONE = Long.fromInt(1);
  /** Unsigned one. */
  static UONE = Long.fromInt(1, true);
  /** Signed negative one. */
  static NEG_ONE = Long.fromInt(-1);
  /** Maximum signed value. */
  static MAX_VALUE = Long.fromBits(0xffffffff | 0, 0x7fffffff | 0, false);
  /** Minimum signed value. */
  static MIN_VALUE = Long.fromBits(0, 0x80000000 | 0, false);

  /**
   * Returns a Long representing the 64 bit integer that comes by concatenating the given low and high bits.
   * Each is assumed to use 32 bits.
   * @param lowBits - The low 32 bits
   * @param highBits - The high 32 bits
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromBits(lowBits: number, highBits: number, unsigned?: boolean): Long {
    return new Long(lowBits, highBits, unsigned);
  }

  /**
   * Returns a Long representing the given 32 bit integer value.
   * @param value - The 32 bit integer in question
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromInt(value: number, unsigned?: boolean): Long {
    let obj, cachedObj, cache;
    if (unsigned) {
      value >>>= 0;
      if ((cache = 0 <= value && value < 256)) {
        cachedObj = UINT_CACHE[value];
        if (cachedObj) return cachedObj;
      }
      obj = Long.fromBits(value, (value | 0) < 0 ? -1 : 0, true);
      if (cache) UINT_CACHE[value] = obj;
      return obj;
    } else {
      value |= 0;
      if ((cache = -128 <= value && value < 128)) {
        cachedObj = INT_CACHE[value];
        if (cachedObj) return cachedObj;
      }
      obj = Long.fromBits(value, value < 0 ? -1 : 0, false);
      if (cache) INT_CACHE[value] = obj;
      return obj;
    }
  }

  /**
   * Returns a Long representing the given value, provided that it is a finite number. Otherwise, zero is returned.
   * @param value - The number in question
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromNumber(value: number, unsigned?: boolean): Long {
    if (isNaN(value)) return unsigned ? Long.UZERO : Long.ZERO;
    if (unsigned) {
      if (value < 0) return Long.UZERO;
      if (value >= TWO_PWR_64_DBL) return Long.MAX_UNSIGNED_VALUE;
    } else {
      if (value <= -TWO_PWR_63_DBL) return Long.MIN_VALUE;
      if (value + 1 >= TWO_PWR_63_DBL) return Long.MAX_VALUE;
    }
    if (value < 0) return Long.fromNumber(-value, unsigned).neg();
    return Long.fromBits(value % TWO_PWR_32_DBL | 0, (value / TWO_PWR_32_DBL) | 0, unsigned);
  }

  /**
   * Returns a Long representing the given value, provided that it is a finite number. Otherwise, zero is returned.
   * @param value - The number in question
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromBigInt(value: bigint, unsigned?: boolean): Long {
    return Long.fromString(value.toString(10), unsigned);
  }

  /**
   * Returns a Long representation of the given string, written using the specified radix.
   * @param str - The textual representation of the Long
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @param radix - The radix in which the text is written (2-36), defaults to 10
   * @returns The corresponding Long value
   */
  static fromString(str: string, unsigned?: boolean, radix?: number): Long {
    if (str.length === 0) throw Error('empty string');
    if (str === 'NaN' || str === 'Infinity' || str === '+Infinity' || str === '-Infinity')
      return Long.ZERO;
    if (typeof unsigned === 'number') {
      // For goog.math.long compatibility
      (radix = unsigned), (unsigned = false);
    } else {
      unsigned = !!unsigned;
    }
    radix = radix || 10;
    if (radix < 2 || 36 < radix) throw RangeError('radix');

    let p;
    if ((p = str.indexOf('-')) > 0) throw Error('interior hyphen');
    else if (p === 0) {
      return Long.fromString(str.substring(1), unsigned, radix).neg();
    }

    // Do several (8) digits each time through the loop, so as to
    // minimize the calls to the very expensive emulated div.
    const radixToPower = Long.fromNumber(Math.pow(radix, 8));

    let result = Long.ZERO;
    for (let i = 0; i < str.length; i += 8) {
      const size = Math.min(8, str.length - i),
        value = parseInt(str.substring(i, i + size), radix);
      if (size < 8) {
        const power = Long.fromNumber(Math.pow(radix, size));
        result = result.mul(power).add(Long.fromNumber(value));
      } else {
        result = result.mul(radixToPower);
        result = result.add(Long.fromNumber(value));
      }
    }
    result.unsigned = unsigned;
    return result;
  }

  /**
   * Creates a Long from its byte representation.
   * @param bytes - Byte representation
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @param le - Whether little or big endian, defaults to big endian
   * @returns The corresponding Long value
   */
  static fromBytes(bytes: number[], unsigned?: boolean, le?: boolean): Long {
    return le ? Long.fromBytesLE(bytes, unsigned) : Long.fromBytesBE(bytes, unsigned);
  }

  /**
   * Creates a Long from its little endian byte representation.
   * @param bytes - Little endian byte representation
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromBytesLE(bytes: number[], unsigned?: boolean): Long {
    return new Long(
      bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24),
      bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24),
      unsigned
    );
  }

  /**
   * Creates a Long from its big endian byte representation.
   * @param bytes - Big endian byte representation
   * @param unsigned - Whether unsigned or not, defaults to signed
   * @returns The corresponding Long value
   */
  static fromBytesBE(bytes: number[], unsigned?: boolean): Long {
    return new Long(
      (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7],
      (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3],
      unsigned
    );
  }

  /**
   * Tests if the specified object is a Long.
   */
  static isLong(value: unknown): value is Long {
    return isObjectLike(value) && value['__isLong__'] === true;
  }

  /**
   * Converts the specified value to a Long.
   * @param unsigned - Whether unsigned or not, defaults to signed
   */
  static fromValue(
    val: number | string | { low: number; high: number; unsigned?: boolean },
    unsigned?: boolean
  ): Long {
    if (typeof val === 'number') return Long.fromNumber(val, unsigned);
    if (typeof val === 'string') return Long.fromString(val, unsigned);
    // Throws for non-objects, converts non-instanceof Long:
    return Long.fromBits(
      val.low,
      val.high,
      typeof unsigned === 'boolean' ? unsigned : val.unsigned
    );
  }

  /** Returns the sum of this and the specified Long. */
  add(addend: string | number | Long | Timestamp): Long {
    if (!Long.isLong(addend)) addend = Long.fromValue(addend);

    // Divide each number into 4 chunks of 16 bits, and then sum the chunks.

    const a48 = this.high >>> 16;
    const a32 = this.high & 0xffff;
    const a16 = this.low >>> 16;
    const a00 = this.low & 0xffff;

    const b48 = addend.high >>> 16;
    const b32 = addend.high & 0xffff;
    const b16 = addend.low >>> 16;
    const b00 = addend.low & 0xffff;

    let c48 = 0,
      c32 = 0,
      c16 = 0,
      c00 = 0;
    c00 += a00 + b00;
    c16 += c00 >>> 16;
    c00 &= 0xffff;
    c16 += a16 + b16;
    c32 += c16 >>> 16;
    c16 &= 0xffff;
    c32 += a32 + b32;
    c48 += c32 >>> 16;
    c32 &= 0xffff;
    c48 += a48 + b48;
    c48 &= 0xffff;
    return Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32, this.unsigned);
  }

  /**
   * Returns the sum of this and the specified Long.
   * @returns Sum
   */
  and(other: string | number | Long | Timestamp): Long {
    if (!Long.isLong(other)) other = Long.fromValue(other);
    return Long.fromBits(this.low & other.low, this.high & other.high, this.unsigned);
  }

  /**
   * Compares this Long's value with the specified's.
   * @returns 0 if they are the same, 1 if the this is greater and -1 if the given one is greater
   */
  compare(other: string | number | Long | Timestamp): 0 | 1 | -1 {
    if (!Long.isLong(other)) other = Long.fromValue(other);
    if (this.eq(other)) return 0;
    const thisNeg = this.isNegative(),
      otherNeg = other.isNegative();
    if (thisNeg && !otherNeg) return -1;
    if (!thisNeg && otherNeg) return 1;
    // At this point the sign bits are the same
    if (!this.unsigned) return this.sub(other).isNegative() ? -1 : 1;
    // Both are positive if at least one is unsigned
    return other.high >>> 0 > this.high >>> 0 ||
      (other.high === this.high && other.low >>> 0 > this.low >>> 0)
      ? -1
      : 1;
  }

  /** This is an alias of {@link Long.compare} */
  comp = Long.prototype.compare;

  /**
   * Returns this Long divided by the specified. The result is signed if this Long is signed or unsigned if this Long is unsigned.
   * @returns Quotient
   */
  divide(divisor: string | number | Long | Timestamp): Long {
    if (!Long.isLong(divisor)) divisor = Long.fromValue(divisor);
    if (divisor.isZero()) throw Error('division by zero');

    // use wasm support if present
    if (wasm) {
      // guard against signed division overflow: the largest
      // negative number / -1 would be 1 larger than the largest
      // positive number, due to two's complement.
      if (
        !this.unsigned &&
        this.high === -0x80000000 &&
        divisor.low === -1 &&
        divisor.high === -1
      ) {
        // be consistent with non-wasm code path
        return this;
      }
      const low = (this.unsigned ? wasm.div_u : wasm.div_s)(
        this.low,
        this.high,
        divisor.low,
        divisor.high
      );
      return Long.fromBits(low, wasm.get_high(), this.unsigned);
    }

    if (this.isZero()) return this.unsigned ? Long.UZERO : Long.ZERO;
    let approx, rem, res;
    if (!this.unsigned) {
      // This section is only relevant for signed longs and is derived from the
      // closure library as a whole.
      if (this.eq(Long.MIN_VALUE)) {
        if (divisor.eq(Long.ONE) || divisor.eq(Long.NEG_ONE)) return Long.MIN_VALUE;
        // recall that -MIN_VALUE == MIN_VALUE
        else if (divisor.eq(Long.MIN_VALUE)) return Long.ONE;
        else {
          // At this point, we have |other| >= 2, so |this/other| < |MIN_VALUE|.
          const halfThis = this.shr(1);
          approx = halfThis.div(divisor).shl(1);
          if (approx.eq(Long.ZERO)) {
            return divisor.isNegative() ? Long.ONE : Long.NEG_ONE;
          } else {
            rem = this.sub(divisor.mul(approx));
            res = approx.add(rem.div(divisor));
            return res;
          }
        }
      } else if (divisor.eq(Long.MIN_VALUE)) return this.unsigned ? Long.UZERO : Long.ZERO;
      if (this.isNegative()) {
        if (divisor.isNegative()) return this.neg().div(divisor.neg());
        return this.neg().div(divisor).neg();
      } else if (divisor.isNegative()) return this.div(divisor.neg()).neg();
      res = Long.ZERO;
    } else {
      // The algorithm below has not been made for unsigned longs. It's therefore
      // required to take special care of the MSB prior to running it.
      if (!divisor.unsigned) divisor = divisor.toUnsigned();
      if (divisor.gt(this)) return Long.UZERO;
      if (divisor.gt(this.shru(1)))
        // 15 >>> 1 = 7 ; with divisor = 8 ; true
        return Long.UONE;
      res = Long.UZERO;
    }

    // Repeat the following until the remainder is less than other:  find a
    // floating-point that approximates remainder / other *from below*, add this
    // into the result, and subtract it from the remainder.  It is critical that
    // the approximate value is less than or equal to the real value so that the
    // remainder never becomes negative.
    rem = this;
    while (rem.gte(divisor)) {
      // Approximate the result of division. This may be a little greater or
      // smaller than the actual value.
      approx = Math.max(1, Math.floor(rem.toNumber() / divisor.toNumber()));

      // We will tweak the approximate result by changing it in the 48-th digit or
      // the smallest non-fractional digit, whichever is larger.
      const log2 = Math.ceil(Math.log(approx) / Math.LN2);
      const delta = log2 <= 48 ? 1 : Math.pow(2, log2 - 48);
      // Decrease the approximation until it is smaller than the remainder.  Note
      // that if it is too large, the product overflows and is negative.
      let approxRes = Long.fromNumber(approx);
      let approxRem = approxRes.mul(divisor);
      while (approxRem.isNegative() || approxRem.gt(rem)) {
        approx -= delta;
        approxRes = Long.fromNumber(approx, this.unsigned);
        approxRem = approxRes.mul(divisor);
      }

      // We know the answer can't be zero... and actually, zero would cause
      // infinite recursion since we would make no progress.
      if (approxRes.isZero()) approxRes = Long.ONE;

      res = res.add(approxRes);
      rem = rem.sub(approxRem);
    }
    return res;
  }

  /**This is an alias of {@link Long.divide} */
  div = Long.prototype.divide;

  /**
   * Tests if this Long's value equals the specified's.
   * @param other - Other value
   */
  equals(other: string | number | Long | Timestamp): boolean {
    if (!Long.isLong(other)) other = Long.fromValue(other);
    if (this.unsigned !== other.unsigned && this.high >>> 31 === 1 && other.high >>> 31 === 1)
      return false;
    return this.high === other.high && this.low === other.low;
  }

  /** This is an alias of {@link Long.equals} */
  eq = Long.prototype.equals;

  /** Gets the high 32 bits as a signed integer. */
  getHighBits(): number {
    return this.high;
  }

  /** Gets the high 32 bits as an unsigned integer. */
  getHighBitsUnsigned(): number {
    return this.high >>> 0;
  }

  /** Gets the low 32 bits as a signed integer. */
  getLowBits(): number {
    return this.low;
  }

  /** Gets the low 32 bits as an unsigned integer. */
  getLowBitsUnsigned(): number {
    return this.low >>> 0;
  }

  /** Gets the number of bits needed to represent the absolute value of this Long. */
  getNumBitsAbs(): number {
    if (this.isNegative()) {
      // Unsigned Longs are never negative
      return this.eq(Long.MIN_VALUE) ? 64 : this.neg().getNumBitsAbs();
    }
    const val = this.high !== 0 ? this.high : this.low;
    let bit: number;
    for (bit = 31; bit > 0; bit--) if ((val & (1 << bit)) !== 0) break;
    return this.high !== 0 ? bit + 33 : bit + 1;
  }

  /** Tests if this Long's value is greater than the specified's. */
  greaterThan(other: string | number | Long | Timestamp): boolean {
    return this.comp(other) > 0;
  }

  /** This is an alias of {@link Long.greaterThan} */
  gt = Long.prototype.greaterThan;

  /** Tests if this Long's value is greater than or equal the specified's. */
  greaterThanOrEqual(other: string | number | Long | Timestamp): boolean {
    return this.comp(other) >= 0;
  }

  /** This is an alias of {@link Long.greaterThanOrEqual} */
  gte = Long.prototype.greaterThanOrEqual;
  /** This is an alias of {@link Long.greaterThanOrEqual} */
  ge = Long.prototype.greaterThanOrEqual;

  /** Tests if this Long's value is even. */
  isEven(): boolean {
    return (this.low & 1) === 0;
  }

  /** Tests if this Long's value is negative. */
  isNegative(): boolean {
    return !this.unsigned && this.high < 0;
  }

  /** Tests if this Long's value is odd. */
  isOdd(): boolean {
    return (this.low & 1) === 1;
  }

  /** Tests if this Long's value is positive. */
  isPositive(): boolean {
    return this.unsigned || this.high >= 0;
  }

  /** Tests if this Long's value equals zero. */
  isZero(): boolean {
    return this.high === 0 && this.low === 0;
  }

  /** Tests if this Long's value is less than the specified's. */
  lessThan(other: string | number | Long | Timestamp): boolean {
    return this.comp(other) < 0;
  }

  /** This is an alias of {@link Long#lessThan}. */
  lt = Long.prototype.lessThan;

  /** Tests if this Long's value is less than or equal the specified's. */
  lessThanOrEqual(other: string | number | Long | Timestamp): boolean {
    return this.comp(other) <= 0;
  }

  /** This is an alias of {@link Long.lessThanOrEqual} */
  lte = Long.prototype.lessThanOrEqual;

  /** Returns this Long modulo the specified. */
  modulo(divisor: string | number | Long | Timestamp): Long {
    if (!Long.isLong(divisor)) divisor = Long.fromValue(divisor);

    // use wasm support if present
    if (wasm) {
      const low = (this.unsigned ? wasm.rem_u : wasm.rem_s)(
        this.low,
        this.high,
        divisor.low,
        divisor.high
      );
      return Long.fromBits(low, wasm.get_high(), this.unsigned);
    }

    return this.sub(this.div(divisor).mul(divisor));
  }

  /** This is an alias of {@link Long.modulo} */
  mod = Long.prototype.modulo;
  /** This is an alias of {@link Long.modulo} */
  rem = Long.prototype.modulo;

  /**
   * Returns the product of this and the specified Long.
   * @param multiplier - Multiplier
   * @returns Product
   */
  multiply(multiplier: string | number | Long | Timestamp): Long {
    if (this.isZero()) return Long.ZERO;
    if (!Long.isLong(multiplier)) multiplier = Long.fromValue(multiplier);

    // use wasm support if present
    if (wasm) {
      const low = wasm.mul(this.low, this.high, multiplier.low, multiplier.high);
      return Long.fromBits(low, wasm.get_high(), this.unsigned);
    }

    if (multiplier.isZero()) return Long.ZERO;
    if (this.eq(Long.MIN_VALUE)) return multiplier.isOdd() ? Long.MIN_VALUE : Long.ZERO;
    if (multiplier.eq(Long.MIN_VALUE)) return this.isOdd() ? Long.MIN_VALUE : Long.ZERO;

    if (this.isNegative()) {
      if (multiplier.isNegative()) return this.neg().mul(multiplier.neg());
      else return this.neg().mul(multiplier).neg();
    } else if (multiplier.isNegative()) return this.mul(multiplier.neg()).neg();

    // If both longs are small, use float multiplication
    if (this.lt(Long.TWO_PWR_24) && multiplier.lt(Long.TWO_PWR_24))
      return Long.fromNumber(this.toNumber() * multiplier.toNumber(), this.unsigned);

    // Divide each long into 4 chunks of 16 bits, and then add up 4x4 products.
    // We can skip products that would overflow.

    const a48 = this.high >>> 16;
    const a32 = this.high & 0xffff;
    const a16 = this.low >>> 16;
    const a00 = this.low & 0xffff;

    const b48 = multiplier.high >>> 16;
    const b32 = multiplier.high & 0xffff;
    const b16 = multiplier.low >>> 16;
    const b00 = multiplier.low & 0xffff;

    let c48 = 0,
      c32 = 0,
      c16 = 0,
      c00 = 0;
    c00 += a00 * b00;
    c16 += c00 >>> 16;
    c00 &= 0xffff;
    c16 += a16 * b00;
    c32 += c16 >>> 16;
    c16 &= 0xffff;
    c16 += a00 * b16;
    c32 += c16 >>> 16;
    c16 &= 0xffff;
    c32 += a32 * b00;
    c48 += c32 >>> 16;
    c32 &= 0xffff;
    c32 += a16 * b16;
    c48 += c32 >>> 16;
    c32 &= 0xffff;
    c32 += a00 * b32;
    c48 += c32 >>> 16;
    c32 &= 0xffff;
    c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
    c48 &= 0xffff;
    return Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32, this.unsigned);
  }

  /** This is an alias of {@link Long.multiply} */
  mul = Long.prototype.multiply;

  /** Returns the Negation of this Long's value. */
  negate(): Long {
    if (!this.unsigned && this.eq(Long.MIN_VALUE)) return Long.MIN_VALUE;
    return this.not().add(Long.ONE);
  }

  /** This is an alias of {@link Long.negate} */
  neg = Long.prototype.negate;

  /** Returns the bitwise NOT of this Long. */
  not(): Long {
    return Long.fromBits(~this.low, ~this.high, this.unsigned);
  }

  /** Tests if this Long's value differs from the specified's. */
  notEquals(other: string | number | Long | Timestamp): boolean {
    return !this.equals(other);
  }

  /** This is an alias of {@link Long.notEquals} */
  neq = Long.prototype.notEquals;
  /** This is an alias of {@link Long.notEquals} */
  ne = Long.prototype.notEquals;

  /**
   * Returns the bitwise OR of this Long and the specified.
   */
  or(other: number | string | Long): Long {
    if (!Long.isLong(other)) other = Long.fromValue(other);
    return Long.fromBits(this.low | other.low, this.high | other.high, this.unsigned);
  }

  /**
   * Returns this Long with bits shifted to the left by the given amount.
   * @param numBits - Number of bits
   * @returns Shifted Long
   */
  shiftLeft(numBits: number | Long): Long {
    if (Long.isLong(numBits)) numBits = numBits.toInt();
    if ((numBits &= 63) === 0) return this;
    else if (numBits < 32)
      return Long.fromBits(
        this.low << numBits,
        (this.high << numBits) | (this.low >>> (32 - numBits)),
        this.unsigned
      );
    else return Long.fromBits(0, this.low << (numBits - 32), this.unsigned);
  }

  /** This is an alias of {@link Long.shiftLeft} */
  shl = Long.prototype.shiftLeft;

  /**
   * Returns this Long with bits arithmetically shifted to the right by the given amount.
   * @param numBits - Number of bits
   * @returns Shifted Long
   */
  shiftRight(numBits: number | Long): Long {
    if (Long.isLong(numBits)) numBits = numBits.toInt();
    if ((numBits &= 63) === 0) return this;
    else if (numBits < 32)
      return Long.fromBits(
        (this.low >>> numBits) | (this.high << (32 - numBits)),
        this.high >> numBits,
        this.unsigned
      );
    else return Long.fromBits(this.high >> (numBits - 32), this.high >= 0 ? 0 : -1, this.unsigned);
  }

  /** This is an alias of {@link Long.shiftRight} */
  shr = Long.prototype.shiftRight;

  /**
   * Returns this Long with bits logically shifted to the right by the given amount.
   * @param numBits - Number of bits
   * @returns Shifted Long
   */
  shiftRightUnsigned(numBits: Long | number): Long {
    if (Long.isLong(numBits)) numBits = numBits.toInt();
    numBits &= 63;
    if (numBits === 0) return this;
    else {
      const high = this.high;
      if (numBits < 32) {
        const low = this.low;
        return Long.fromBits(
          (low >>> numBits) | (high << (32 - numBits)),
          high >>> numBits,
          this.unsigned
        );
      } else if (numBits === 32) return Long.fromBits(high, 0, this.unsigned);
      else return Long.fromBits(high >>> (numBits - 32), 0, this.unsigned);
    }
  }

  /** This is an alias of {@link Long.shiftRightUnsigned} */
  shr_u = Long.prototype.shiftRightUnsigned;
  /** This is an alias of {@link Long.shiftRightUnsigned} */
  shru = Long.prototype.shiftRightUnsigned;

  /**
   * Returns the difference of this and the specified Long.
   * @param subtrahend - Subtrahend
   * @returns Difference
   */
  subtract(subtrahend: string | number | Long | Timestamp): Long {
    if (!Long.isLong(subtrahend)) subtrahend = Long.fromValue(subtrahend);
    return this.add(subtrahend.neg());
  }

  /** This is an alias of {@link Long.subtract} */
  sub = Long.prototype.subtract;

  /** Converts the Long to a 32 bit integer, assuming it is a 32 bit integer. */
  toInt(): number {
    return this.unsigned ? this.low >>> 0 : this.low;
  }

  /** Converts the Long to a the nearest floating-point representation of this value (double, 53 bit mantissa). */
  toNumber(): number {
    if (this.unsigned) return (this.high >>> 0) * TWO_PWR_32_DBL + (this.low >>> 0);
    return this.high * TWO_PWR_32_DBL + (this.low >>> 0);
  }

  /** Converts the Long to a BigInt (arbitrary precision). */
  toBigInt(): bigint {
    return BigInt(this.toString());
  }

  /**
   * Converts this Long to its byte representation.
   * @param le - Whether little or big endian, defaults to big endian
   * @returns Byte representation
   */
  toBytes(le?: boolean): number[] {
    return le ? this.toBytesLE() : this.toBytesBE();
  }

  /**
   * Converts this Long to its little endian byte representation.
   * @returns Little endian byte representation
   */
  toBytesLE(): number[] {
    const hi = this.high,
      lo = this.low;
    return [
      lo & 0xff,
      (lo >>> 8) & 0xff,
      (lo >>> 16) & 0xff,
      lo >>> 24,
      hi & 0xff,
      (hi >>> 8) & 0xff,
      (hi >>> 16) & 0xff,
      hi >>> 24
    ];
  }

  /**
   * Converts this Long to its big endian byte representation.
   * @returns Big endian byte representation
   */
  toBytesBE(): number[] {
    const hi = this.high,
      lo = this.low;
    return [
      hi >>> 24,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      lo >>> 24,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff
    ];
  }

  /**
   * Converts this Long to signed.
   */
  toSigned(): Long {
    if (!this.unsigned) return this;
    return Long.fromBits(this.low, this.high, false);
  }

  /**
   * Converts the Long to a string written in the specified radix.
   * @param radix - Radix (2-36), defaults to 10
   * @throws RangeError If `radix` is out of range
   */
  toString(radix?: number): string {
    radix = radix || 10;
    if (radix < 2 || 36 < radix) throw RangeError('radix');
    if (this.isZero()) return '0';
    if (this.isNegative()) {
      // Unsigned Longs are never negative
      if (this.eq(Long.MIN_VALUE)) {
        // We need to change the Long value before it can be negated, so we remove
        // the bottom-most digit in this base and then recurse to do the rest.
        const radixLong = Long.fromNumber(radix),
          div = this.div(radixLong),
          rem1 = div.mul(radixLong).sub(this);
        return div.toString(radix) + rem1.toInt().toString(radix);
      } else return '-' + this.neg().toString(radix);
    }

    // Do several (6) digits each time through the loop, so as to
    // minimize the calls to the very expensive emulated div.
    const radixToPower = Long.fromNumber(Math.pow(radix, 6), this.unsigned);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let rem: Long = this;
    let result = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remDiv = rem.div(radixToPower);
      const intval = rem.sub(remDiv.mul(radixToPower)).toInt() >>> 0;
      let digits = intval.toString(radix);
      rem = remDiv;
      if (rem.isZero()) {
        return digits + result;
      } else {
        while (digits.length < 6) digits = '0' + digits;
        result = '' + digits + result;
      }
    }
  }

  /** Converts this Long to unsigned. */
  toUnsigned(): Long {
    if (this.unsigned) return this;
    return Long.fromBits(this.low, this.high, true);
  }

  /** Returns the bitwise XOR of this Long and the given one. */
  xor(other: Long | number | string): Long {
    if (!Long.isLong(other)) other = Long.fromValue(other);
    return Long.fromBits(this.low ^ other.low, this.high ^ other.high, this.unsigned);
  }

  /** This is an alias of {@link Long.isZero} */
  eqz = Long.prototype.isZero;

  /** This is an alias of {@link Long.lessThanOrEqual} */
  le = Long.prototype.lessThanOrEqual;

  /*
   ****************************************************************
   *                  BSON SPECIFIC ADDITIONS                     *
   ****************************************************************
   */
  toExtendedJSON(options?: EJSONOptions): number | { $numberLong: string } {
    if (options && options.relaxed) return this.toNumber();
    return { $numberLong: this.toString() };
  }
  static fromExtendedJSON(doc: { $numberLong: string }, options?: EJSONOptions): number | Long {
    const result = Long.fromString(doc.$numberLong);
    return options && options.relaxed ? result.toNumber() : result;
  }
}

Object.defineProperty(Long.prototype, '__isLong__', { value: true });
Object.defineProperty(Long.prototype, '_bsontype', { value: 'Long' });
