import { Binary, UUID } from '../binary';
import type { Document } from '../bson';
import { Code } from '../code';
import * as constants from '../constants';
import { DBRef, type DBRefLike, isDBRefLike } from '../db_ref';
import { Decimal128 } from '../decimal128';
import { Double } from '../double';
import { BSONError } from '../error';
import { Int32 } from '../int_32';
import { Long } from '../long';
import { MaxKey } from '../max_key';
import { MinKey } from '../min_key';
import { ObjectId } from '../objectid';
import { BSONRegExp } from '../regexp';
import { BSONSymbol } from '../symbol';
import { Timestamp } from '../timestamp';
import { ByteUtils } from '../utils/byte_utils';
import { NumberUtils } from '../utils/number_utils';

/** @public */
export interface DeserializeOptions {
  /**
   * when deserializing a Long return as a BigInt.
   * @defaultValue `false`
   */
  useBigInt64?: boolean;
  /**
   * when deserializing a Long will fit it into a Number if it's smaller than 53 bits.
   * @defaultValue `true`
   */
  promoteLongs?: boolean;
  /**
   * when deserializing a Binary will return it as a node.js Buffer instance.
   * @defaultValue `false`
   */
  promoteBuffers?: boolean;
  /**
   * when deserializing will promote BSON values to their Node.js closest equivalent types.
   * @defaultValue `true`
   */
  promoteValues?: boolean;
  /**
   * allow to specify if there what fields we wish to return as unserialized raw buffer.
   * @defaultValue `null`
   */
  fieldsAsRaw?: Document;
  /**
   * return BSON regular expressions as BSONRegExp instances.
   * @defaultValue `false`
   */
  bsonRegExp?: boolean;
  /**
   * allows the buffer to be larger than the parsed BSON object.
   * @defaultValue `false`
   */
  allowObjectSmallerThanBufferSize?: boolean;
  /**
   * Offset into buffer to begin reading document from
   * @defaultValue `0`
   */
  index?: number;

  raw?: boolean;
  /** Allows for opt-out utf-8 validation for all keys or
   * specified keys. Must be all true or all false.
   *
   * @example
   * ```js
   * // disables validation on all keys
   *  validation: { utf8: false }
   *
   * // enables validation only on specified keys a, b, and c
   *  validation: { utf8: { a: true, b: true, c: true } }
   *
   *  // disables validation only on specified keys a, b
   *  validation: { utf8: { a: false, b: false } }
   * ```
   */
  validation?: { utf8: boolean | Record<string, true> | Record<string, false> };
}

interface Shape {
  parent: Shape | null;
  children: Record<string, Shape>;
  key: string;
  type: number;
  typeShape?: Shape;
  useCount: number;
  parser?: (buf: Uint8Array, index: number, size: number, target: Document | unknown[]) => [value: Document, index: number];
};

const headShape: Shape = makeHeadShape();

function makeHeadShape(): Shape {
  return {
    parent: null,
    children: Object.create(null),
    key: '',
    type: -1,
    useCount: 0
  };
}

function getHeadShape(shape: Shape | undefined): Shape | undefined {
  return shape?.parent ? getHeadShape(shape.parent) : shape;
}

function lookupShape(head: Shape, type: number, name: string | number, options: DeserializeOptions): Shape {
  const key = `${type}:${name}`;
  const shape = (head.children[key] ??= {
    parent: head,
    children: Object.create(null),
    key: `${name}`,
    type: type,
    useCount: 0
  });
  return increaseUseCount(shape, options);
}

declare global {
  const process: { env: Record<string, string | undefined>; };
  const console: any;
}

let FallbackError: unknown;
let fallback: (msg: string) => string;
let fallback$: (msg: string) => string;
let isFallback: (expr: string) => string;
let isFallbackFn: (arg: unknown) => boolean;
if (process.env.ENABLE_BSON_SHAPE_PARSING === 'debug') {
  FallbackError = class FallbackError extends Error {};
  fallback = (msg) => `throw new FallbackError(${JSON.stringify(msg)})`;
  fallback$ = (msg) => `throw new FallbackError(\`${msg}\`)`;
  isFallback = (e: string) => `((${e}) instanceof FallbackError)`;
} else {
  FallbackError = new class FallbackError {};
  fallback = () => 'throw FallbackError';
  fallback$ = () => 'throw FallbackError';
  isFallback = (e: string) => `(${e}) === FallbackError`;
}
isFallbackFn = eval(`(arg) => ${isFallback('arg')}`);

const THRESHOLD = 1000 as const;

function increaseUseCount(shape: Shape, options: DeserializeOptions): Shape {
  shape.useCount++;

  if (shape.useCount > THRESHOLD) {
    compile(shape, options);
  }
  return shape;
}

function compile(shape: Shape, options: DeserializeOptions): void {
  if (!process.env.ENABLE_BSON_SHAPE_PARSING) return;
  if (shape.parser) return;
  const promoteBuffers = options.promoteBuffers ?? false;
  const promoteLongs = options.promoteLongs ?? true;
  const promoteValues = options.promoteValues ?? true;
  const useBigInt64 = options.useBigInt64 ?? false;

  const headTypeShape = getHeadShape(shape.typeShape);
  headTypeShape && compile(headTypeShape, options);
  const bindings: Record<string, unknown> = { NumberUtils, ByteUtils, FallbackError, shape, headTypeShape };
  let src = `(function (buffer, index, target) {
  const originalIndex = index;`;
  if (shape.type === -1) {
    src += `
    const size = NumberUtils.getInt32LE(buffer, index);
    index += 4;`;
  } else {
    src += `
    if (buffer[index] !== ${shape.type}) {
      ${fallback$(`mismatched type, wanted ${shape.type} but got \${buffer[index]}`)};
    }
    index++;
    `;
  }

  if (shape.type !== -1) {
    const keyAsUtf8 = new Uint8Array(ByteUtils.utf8ByteLength(shape.key));
    ByteUtils.encodeUTF8Into(keyAsUtf8, shape.key, 0);
    for (const byte of keyAsUtf8) {
      src += `if (buffer[index++] !== ${byte}) ${fallback('mismatched key byte')};\n`;
    }
    src += `if (buffer[index++] !== 0) ${fallback('mismatched key terminator')};\n`;
  }
  src += `let value; {\n`;
  switch (shape.type) {
    case -1:
      // This is a special case for the head shape
      src += `value = target = {};`;
      break;
    case constants.BSON_DATA_BINARY:
      bindings.Binary = Binary;
      bindings.UUID = UUID;
      src += `
      let binarySize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      const totalBinarySize = binarySize;
      const subType = buffer[index++];
      if (binarySize < 0) ${fallback('negative binary type element size found')};

      // Is the length longer than the document
      if (binarySize > buffer.byteLength)
        ${fallback('document length exceeded')};

      // If we have subtype 2 skip the 4 bytes for the size
      if (subType === Binary.SUBTYPE_BYTE_ARRAY) {
        binarySize = NumberUtils.getInt32LE(buffer, index);
        index += 4;
        if (binarySize < 0)
          ${fallback('negative binary type element size found')};
        if (binarySize > totalBinarySize - 4)
          ${fallback('document length exceeded')};
        if (binarySize < totalBinarySize - 4)
          ${fallback('document length exceeded')};
      }

      if (${promoteBuffers} && ${promoteValues}) {
        value = ByteUtils.toLocalBufferType(buffer.subarray(index, index + binarySize));
      } else {
        value = new Binary(buffer.subarray(index, index + binarySize), subType);
        if (subType === ${constants.BSON_BINARY_SUBTYPE_UUID_NEW} && UUID.isValid(value)) {
          value = value.toUUID();
        }
      }

      // Update the index
      index = index + binarySize;
      `;
      break;
    case constants.BSON_DATA_BOOLEAN:
      src += `
      if (buffer[index] !== 0 && buffer[index] !== 1)
        ${fallback('illegal boolean type value')};
      value = buffer[index++] === 1;`;
      break;
    case constants.BSON_DATA_DATE:
      bindings.Long = Long;
      src += `
      const lowBits = NumberUtils.getInt32LE(buffer, index);
      const highBits = NumberUtils.getInt32LE(buffer, index + 4);
      index += 8;

      value = new Date(new Long(lowBits, highBits).toNumber());`;
      break;
    case constants.BSON_DATA_INT:
      src += `
      value = ${promoteValues === false ? 'new Int32' : ''}(NumberUtils.getInt32LE(buffer, index));
      index += 4;`;
      break;
    case constants.BSON_DATA_LONG:
      bindings.Long = Long;
      if (useBigInt64) {
        src += `
        value = NumberUtils.getBigInt64LE(buffer, index);
        index += 8;`;
      } else {
        src += `
        // Unpack the low and high bits
        const lowBits = NumberUtils.getInt32LE(buffer, index);
        const highBits = NumberUtils.getInt32LE(buffer, index + 4);
        index += 8;

        const long = new Long(lowBits, highBits);
        // Promote the long if possible
        if (${promoteLongs && promoteValues === true}) {
          value =
            long.lessThanOrEqual(JS_INT_MAX_LONG) && long.greaterThanOrEqual(JS_INT_MIN_LONG)
              ? long.toNumber()
              : long;
        } else {
          value = long;
        }`;
      }
      break;
    case constants.BSON_DATA_NUMBER:
      src += `
      value = ${promoteValues === false ? 'new Double' : ''}(NumberUtils.getFloat64LE(buffer, index));
      index += 8;`;
      break;
    case constants.BSON_DATA_MAX_KEY:
      bindings.MaxKey = MaxKey;
      src += `value = new MaxKey();`;
      break;
    case constants.BSON_DATA_MIN_KEY:
      bindings.MinKey = MinKey;
      src += `value = new MinKey();`;
      break;
    case constants.BSON_DATA_NULL:
      src += `value = null;`;
      break;
    case constants.BSON_DATA_OID:
      bindings.ObjectId = ObjectId;
      src += `
      const oid = ByteUtils.allocateUnsafe(12);
      for (let i = 0; i < 12; i++) oid[i] = buffer[index + i];
      value = new ObjectId(oid);
      index = index + 12;`;
      break;
    case constants.BSON_DATA_REGEXP:
      bindings.BSONRegExp = BSONRegExp;
      src += `
      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) ${fallback('document length exceeded')};
      // Return the C string
      const source = ByteUtils.toUTF8(buffer, index, i, false);
      // Create the regexp
      index = i + 1;

      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) ${fallback('document length exceeded')};
      // Return the C string
      const regExpOptions = ByteUtils.toUTF8(buffer, index, i, false);
      index = i + 1;

      // For each option add the corresponding one for javascript
      const optionsArray = new Array(regExpOptions.length);

      // Parse options
      for (i = 0; i < regExpOptions.length; i++) {
        switch (regExpOptions[i]) {
          case 'm':
            optionsArray[i] = 'm';
            break;
          case 's':
            optionsArray[i] = 'g';
            break;
          case 'i':
            optionsArray[i] = 'i';
            break;
        }
      }

      value = new BSONRegExp(source, optionsArray.join(''));`;
      break;
    case constants.BSON_DATA_STRING:
      src += `
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        ${fallback('document length exceeded')};
      }
      value = ByteUtils.toUTF8(buffer, index, index + stringSize - 1, false);
      index += stringSize;`;
      break;
    case constants.BSON_DATA_TIMESTAMP:
      bindings.Timestamp = Timestamp;
      src += `
      value = new Timestamp({
        i: NumberUtils.getUint32LE(buffer, index),
        t: NumberUtils.getUint32LE(buffer, index + 4)
      });
      index += 8;`;
      break;
    case constants.BSON_DATA_SYMBOL:
      bindings.BSONSymbol = BSONSymbol;
      src += `
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        ${fallback('document length exceeded')};
      }
      const symbol = ByteUtils.toUTF8(buffer, index, index + stringSize - 1, shouldValidateKey);
      value = ${promoteValues ? 'symbol' : 'new BSONSymbol(symbol)'};
      index += stringSize;`;
      break;
    case constants.BSON_DATA_DECIMAL128:
      bindings.Decimal128 = Decimal128;
      src += `
      // Buffer to contain the decimal bytes
      const bytes = ByteUtils.allocateUnsafe(16);
      // Copy the next 16 bytes into the bytes buffer
      for (let i = 0; i < 16; i++) bytes[i] = buffer[index + i];
      // Update index
      index = index + 16;
      // Assign the new Decimal128 value
      value = new Decimal128(bytes);`;
      break;
    case constants.BSON_DATA_CODE:
      src += `
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        ${fallback('document length exceeded')};
      }
      const functionString = ByteUtils.toUTF8(
        buffer,
        index,
        index + stringSize - 1,
        shouldValidateKey
      );

      value = new Code(functionString);

      // Update parse index position
      index = index + stringSize;`;
      break;
      // deprecated below
    case constants.BSON_DATA_CODE_W_SCOPE:
    case constants.BSON_DATA_DBPOINTER:
    case constants.BSON_DATA_UNDEFINED:
      console.log('deprecated type, not compiling', shape.type, shape.key);
      return;
    case constants.BSON_DATA_OBJECT:
      if (!shape.typeShape) return;
      bindings.deserializeObject = deserializeObject;
      src += `
      value = deserializeObject(buffer, index, ${JSON.stringify(options)}, false, headTypeShape)[0];
      index += NumberUtils.getInt32LE(buffer, index);
      `;
      break;
    case constants.BSON_DATA_ARRAY:
      if (!shape.typeShape) return;
      bindings.deserializeObject = deserializeObject;
      src += `
      value = deserializeObject(buffer, index, ${JSON.stringify(options)}, true, headTypeShape)[0];
      index += NumberUtils.getInt32LE(buffer, index);
      `;
      break;
    default:
      throw new BSONError(`Unsupported type ${shape.type} for key ${shape.key}`);
  }
  src += `}`;
  if (shape.type !== -1) {
    src += `
    target[${JSON.stringify(shape.key)}] = value;
    `;
  }
  src += `
  if (buffer[index] === 0) return target;
  `;

  const totalChildren = Object.values(shape.children).reduce((acc, s) => acc + s.useCount, 0);
  let orderedChildren = Object.entries(shape.children).sort((a, b) => {
    return b[1].useCount - a[1].useCount;
  }).map(([key, value], i) => [key, i, value] as const);
  let accountedChildUsage = 0;

  while (accountedChildUsage < totalChildren * 0.99 || (totalChildren - accountedChildUsage) > 0.9 * THRESHOLD) {
    const [, i, child] = orderedChildren.shift()!;
    accountedChildUsage += child.useCount;
    if (!child.parser) {
      compile(child, options);
      if (!child.parser) return;
    }
    bindings[`p_${i}`] = child.parser;
    src += `
    try {
      // parse ${child.type} ${child.key}
      index = p_${i}(buffer, index, target)[1];
      shape.useCount++;
      return [target, index];
    } catch (e) {
      if (!${isFallback('e')}) throw e;
    }
    `;
  }

  src += `
  if (buffer[index] !== 0) {
    ${fallback$('document did not terminate in 0 byte, found \${buffer[index]}')};
  }
  if (index + 1 !== originalIndex + size) {
    ${fallback('document length mismatched')};
  }

  shape.useCount++;
  return [target, index + 1];
  })`;
  src = `(function parse(` + Object.keys(bindings).join(',') + `) { return (${src}); })`;
  shape.parser = eval(src)(...Object.values(bindings));
}

// Internal long versions
const JS_INT_MAX_LONG = Long.fromNumber(constants.JS_INT_MAX);
const JS_INT_MIN_LONG = Long.fromNumber(constants.JS_INT_MIN);

export function internalDeserialize(
  buffer: Uint8Array,
  options: DeserializeOptions,
  isArray?: boolean
): Document {
  options = options == null ? {} : options;
  const index = options && options.index ? options.index : 0;
  // Read the document size
  const size = NumberUtils.getInt32LE(buffer, index);

  if (size < 5) {
    throw new BSONError(`bson size must be >= 5, is ${size}`);
  }

  if (options.allowObjectSmallerThanBufferSize && buffer.length < size) {
    throw new BSONError(`buffer length ${buffer.length} must be >= bson size ${size}`);
  }

  if (!options.allowObjectSmallerThanBufferSize && buffer.length !== size) {
    throw new BSONError(`buffer length ${buffer.length} must === bson size ${size}`);
  }

  if (size + index > buffer.byteLength) {
    throw new BSONError(
      `(bson size ${size} + options.index ${index} must be <= buffer length ${buffer.byteLength})`
    );
  }

  // Illegal end value
  if (buffer[index + size - 1] !== 0) {
    throw new BSONError(
      "One object, sized correctly, with a spot for an EOO, but the EOO isn't 0x00"
    );
  }

  // Start deserialization
  const [ value, ] = deserializeObject(buffer, index, options, isArray ?? false, headShape);
  return value;
}

const allowedDBRefKeys = /^\$ref$|^\$id$|^\$db$/;

function deserializeObject(
  buffer: Uint8Array,
  index: number,
  options: DeserializeOptions,
  isArray: boolean,
  shape: Shape
): [value: Document, shape: Shape] {
  const fieldsAsRaw = options['fieldsAsRaw'] == null ? null : options['fieldsAsRaw'];

  // Return raw bson buffer instead of parsing it
  const raw = options['raw'] == null ? false : options['raw'];

  // Return BSONRegExp objects instead of native regular expressions
  const bsonRegExp = typeof options['bsonRegExp'] === 'boolean' ? options['bsonRegExp'] : false;

  // Controls the promotion of values vs wrapper classes
  const promoteBuffers = options.promoteBuffers ?? false;
  const promoteLongs = options.promoteLongs ?? true;
  const promoteValues = options.promoteValues ?? true;
  const useBigInt64 = options.useBigInt64 ?? false;

  if (useBigInt64 && !promoteValues) {
    throw new BSONError('Must either request bigint or Long for int64 deserialization');
  }

  if (useBigInt64 && !promoteLongs) {
    throw new BSONError('Must either request bigint or Long for int64 deserialization');
  }

  // Ensures default validation option if none given
  const validation = options.validation == null ? { utf8: true } : options.validation;

  // Shows if global utf-8 validation is enabled or disabled
  let globalUTFValidation = true;
  // Reflects utf-8 validation setting regardless of global or specific key validation
  let validationSetting: boolean;
  // Set of keys either to enable or disable validation on
  let utf8KeysSet;

  // Check for boolean uniformity and empty validation option
  const utf8ValidatedKeys = validation.utf8;
  if (typeof utf8ValidatedKeys === 'boolean') {
    validationSetting = utf8ValidatedKeys;
  } else {
    globalUTFValidation = false;
    const utf8ValidationValues = Object.keys(utf8ValidatedKeys).map(function (key) {
      return utf8ValidatedKeys[key];
    });
    if (utf8ValidationValues.length === 0) {
      throw new BSONError('UTF-8 validation setting cannot be empty');
    }
    if (typeof utf8ValidationValues[0] !== 'boolean') {
      throw new BSONError('Invalid UTF-8 validation option, must specify boolean values');
    }
    validationSetting = utf8ValidationValues[0];
    // Ensures boolean uniformity in utf-8 validation (all true or all false)
    if (!utf8ValidationValues.every(item => item === validationSetting)) {
      throw new BSONError('Invalid UTF-8 validation option - keys must be all true or all false');
    }
  }

  // Add keys to set that will either be validated or not based on validationSetting
  if (!globalUTFValidation) {
    utf8KeysSet = new Set();

    for (const key of Object.keys(utf8ValidatedKeys)) {
      utf8KeysSet.add(key);
    }
  }

  // Set the start index
  const startIndex = index;

  // Validate that we have at least 4 bytes of buffer
  if (buffer.length < 5) throw new BSONError('corrupt bson message < 5 bytes long');

  increaseUseCount(shape, options);
  if (shape.parser && process.env.ENABLE_BSON_SHAPE_PARSING) {
    try {
      return [shape.parser(buffer, index, buffer.byteLength, isArray ? [] : {})[0], shape];
    } catch (e) {
      console.log({e, shape, buffer, index, p: shape.parser.toString()});
      if (isFallbackFn(e)) throw e;
    }
  }

  // Read the document size
  const size = NumberUtils.getInt32LE(buffer, index);
  index += 4;

  // Ensure buffer is valid size
  if (size < 5 || size > buffer.length) throw new BSONError('corrupt bson message');

  // Create holding object
  const object: Document = isArray ? [] : {};
  // Used for arrays to skip having to perform utf8 decoding
  let arrayIndex = 0;
  const done = false;

  let isPossibleDBRef = isArray ? false : null;

  // While we have more left data left keep parsing
  while (!done) {
    // Read the type
    const elementType = buffer[index++];

    // If we get a zero it's the last byte, exit
    if (elementType === 0) break;

    // Get the start search index
    let i = index;
    // Locate the end of the c string
    while (buffer[i] !== 0x00 && i < buffer.length) {
      i++;
    }

    // If are at the end of the buffer there is a problem with the document
    if (i >= buffer.byteLength) throw new BSONError('Bad BSON Document: illegal CString');

    // Represents the key
    const name = isArray ? arrayIndex++ : ByteUtils.toUTF8(buffer, index, i, false);

    const newShape = lookupShape(shape, elementType, name, options);
    if (!isArray) {
      shape = newShape;
    }

    // shouldValidateKey is true if the key should be validated, false otherwise
    let shouldValidateKey = true;
    if (globalUTFValidation || utf8KeysSet?.has(name)) {
      shouldValidateKey = validationSetting;
    } else {
      shouldValidateKey = !validationSetting;
    }

    if (isPossibleDBRef !== false && (name as string)[0] === '$') {
      isPossibleDBRef = allowedDBRefKeys.test(name as string);
    }
    let value;

    index = i + 1;

    if (elementType === constants.BSON_DATA_STRING) {
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      value = ByteUtils.toUTF8(buffer, index, index + stringSize - 1, shouldValidateKey);
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_OID) {
      const oid = ByteUtils.allocateUnsafe(12);
      for (let i = 0; i < 12; i++) oid[i] = buffer[index + i];
      value = new ObjectId(oid);
      index = index + 12;
    } else if (elementType === constants.BSON_DATA_INT && promoteValues === false) {
      value = new Int32(NumberUtils.getInt32LE(buffer, index));
      index += 4;
    } else if (elementType === constants.BSON_DATA_INT) {
      value = NumberUtils.getInt32LE(buffer, index);
      index += 4;
    } else if (elementType === constants.BSON_DATA_NUMBER) {
      value = NumberUtils.getFloat64LE(buffer, index);
      index += 8;
      if (promoteValues === false) value = new Double(value);
    } else if (elementType === constants.BSON_DATA_DATE) {
      const lowBits = NumberUtils.getInt32LE(buffer, index);
      const highBits = NumberUtils.getInt32LE(buffer, index + 4);
      index += 8;

      value = new Date(new Long(lowBits, highBits).toNumber());
    } else if (elementType === constants.BSON_DATA_BOOLEAN) {
      if (buffer[index] !== 0 && buffer[index] !== 1)
        throw new BSONError('illegal boolean type value');
      value = buffer[index++] === 1;
    } else if (elementType === constants.BSON_DATA_OBJECT) {
      const _index = index;
      const objectSize = NumberUtils.getInt32LE(buffer, index);

      if (objectSize <= 0 || objectSize > buffer.length - index)
        throw new BSONError('bad embedded document length in bson');

      let innerShape: Shape | undefined;

      // We have a raw value
      if (raw) {
        value = buffer.subarray(index, index + objectSize);
      } else {
        let objectOptions = options;
        if (!globalUTFValidation) {
          objectOptions = { ...options, validation: { utf8: shouldValidateKey } };
        }
        const headShape = getHeadShape(shape.typeShape) ?? makeHeadShape();
        [value, innerShape] = deserializeObject(buffer, _index, objectOptions, false, increaseUseCount(headShape, options));
      }

      index = index + objectSize;
      shape.typeShape = innerShape;
    } else if (elementType === constants.BSON_DATA_ARRAY) {
      const _index = index;
      const objectSize = NumberUtils.getInt32LE(buffer, index);
      let arrayOptions: DeserializeOptions = options;

      // Stop index
      const stopIndex = index + objectSize;

      // All elements of array to be returned as raw bson
      if (fieldsAsRaw && fieldsAsRaw[name]) {
        arrayOptions = { ...options, raw: true };
      }

      if (!globalUTFValidation) {
        arrayOptions = { ...arrayOptions, validation: { utf8: shouldValidateKey } };
      }

      let innerShape: Shape | undefined = undefined;
      const headShape = getHeadShape(shape.typeShape) ?? makeHeadShape();
      [value, innerShape] = deserializeObject(buffer, _index, arrayOptions, true, increaseUseCount(headShape, options));
      index = index + objectSize;
      shape.typeShape = innerShape;

      if (buffer[index - 1] !== 0) throw new BSONError('invalid array terminator byte');
      if (index !== stopIndex) throw new BSONError('corrupted array bson');
    } else if (elementType === constants.BSON_DATA_UNDEFINED) {
      value = undefined;
    } else if (elementType === constants.BSON_DATA_NULL) {
      value = null;
    } else if (elementType === constants.BSON_DATA_LONG) {
      if (useBigInt64) {
        value = NumberUtils.getBigInt64LE(buffer, index);
        index += 8;
      } else {
        // Unpack the low and high bits
        const lowBits = NumberUtils.getInt32LE(buffer, index);
        const highBits = NumberUtils.getInt32LE(buffer, index + 4);
        index += 8;

        const long = new Long(lowBits, highBits);
        // Promote the long if possible
        if (promoteLongs && promoteValues === true) {
          value =
            long.lessThanOrEqual(JS_INT_MAX_LONG) && long.greaterThanOrEqual(JS_INT_MIN_LONG)
              ? long.toNumber()
              : long;
        } else {
          value = long;
        }
      }
    } else if (elementType === constants.BSON_DATA_DECIMAL128) {
      // Buffer to contain the decimal bytes
      const bytes = ByteUtils.allocateUnsafe(16);
      // Copy the next 16 bytes into the bytes buffer
      for (let i = 0; i < 16; i++) bytes[i] = buffer[index + i];
      // Update index
      index = index + 16;
      // Assign the new Decimal128 value
      value = new Decimal128(bytes);
    } else if (elementType === constants.BSON_DATA_BINARY) {
      let binarySize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      const totalBinarySize = binarySize;
      const subType = buffer[index++];

      // Did we have a negative binary size, throw
      if (binarySize < 0) throw new BSONError('Negative binary type element size found');

      // Is the length longer than the document
      if (binarySize > buffer.byteLength)
        throw new BSONError('Binary type size larger than document size');

      // If we have subtype 2 skip the 4 bytes for the size
      if (subType === Binary.SUBTYPE_BYTE_ARRAY) {
        binarySize = NumberUtils.getInt32LE(buffer, index);
        index += 4;
        if (binarySize < 0)
          throw new BSONError('Negative binary type element size found for subtype 0x02');
        if (binarySize > totalBinarySize - 4)
          throw new BSONError('Binary type with subtype 0x02 contains too long binary size');
        if (binarySize < totalBinarySize - 4)
          throw new BSONError('Binary type with subtype 0x02 contains too short binary size');
      }

      if (promoteBuffers && promoteValues) {
        value = ByteUtils.toLocalBufferType(buffer.subarray(index, index + binarySize));
      } else {
        value = new Binary(buffer.subarray(index, index + binarySize), subType);
        if (subType === constants.BSON_BINARY_SUBTYPE_UUID_NEW && UUID.isValid(value)) {
          value = value.toUUID();
        }
      }

      // Update the index
      index = index + binarySize;
    } else if (elementType === constants.BSON_DATA_REGEXP && bsonRegExp === false) {
      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const source = ByteUtils.toUTF8(buffer, index, i, false);
      // Create the regexp
      index = i + 1;

      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const regExpOptions = ByteUtils.toUTF8(buffer, index, i, false);
      index = i + 1;

      // For each option add the corresponding one for javascript
      const optionsArray = new Array(regExpOptions.length);

      // Parse options
      for (i = 0; i < regExpOptions.length; i++) {
        switch (regExpOptions[i]) {
          case 'm':
            optionsArray[i] = 'm';
            break;
          case 's':
            optionsArray[i] = 'g';
            break;
          case 'i':
            optionsArray[i] = 'i';
            break;
        }
      }

      value = new RegExp(source, optionsArray.join(''));
    } else if (elementType === constants.BSON_DATA_REGEXP && bsonRegExp === true) {
      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const source = ByteUtils.toUTF8(buffer, index, i, false);
      index = i + 1;

      // Get the start search index
      i = index;
      // Locate the end of the c string
      while (buffer[i] !== 0x00 && i < buffer.length) {
        i++;
      }
      // If are at the end of the buffer there is a problem with the document
      if (i >= buffer.length) throw new BSONError('Bad BSON Document: illegal CString');
      // Return the C string
      const regExpOptions = ByteUtils.toUTF8(buffer, index, i, false);
      index = i + 1;

      // Set the object
      value = new BSONRegExp(source, regExpOptions);
    } else if (elementType === constants.BSON_DATA_SYMBOL) {
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      const symbol = ByteUtils.toUTF8(buffer, index, index + stringSize - 1, shouldValidateKey);
      value = promoteValues ? symbol : new BSONSymbol(symbol);
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_TIMESTAMP) {
      value = new Timestamp({
        i: NumberUtils.getUint32LE(buffer, index),
        t: NumberUtils.getUint32LE(buffer, index + 4)
      });
      index += 8;
    } else if (elementType === constants.BSON_DATA_MIN_KEY) {
      value = new MinKey();
    } else if (elementType === constants.BSON_DATA_MAX_KEY) {
      value = new MaxKey();
    } else if (elementType === constants.BSON_DATA_CODE) {
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }
      const functionString = ByteUtils.toUTF8(
        buffer,
        index,
        index + stringSize - 1,
        shouldValidateKey
      );

      value = new Code(functionString);

      // Update parse index position
      index = index + stringSize;
    } else if (elementType === constants.BSON_DATA_CODE_W_SCOPE) {
      const totalSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;

      // Element cannot be shorter than totalSize + stringSize + documentSize + terminator
      if (totalSize < 4 + 4 + 4 + 1) {
        throw new BSONError('code_w_scope total size shorter minimum expected length');
      }

      // Get the code string size
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      // Check if we have a valid string
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      ) {
        throw new BSONError('bad string length in bson');
      }

      // Javascript function
      const functionString = ByteUtils.toUTF8(
        buffer,
        index,
        index + stringSize - 1,
        shouldValidateKey
      );
      // Update parse index position
      index = index + stringSize;
      // Parse the element
      const _index = index;
      // Decode the size of the object document
      const objectSize = NumberUtils.getInt32LE(buffer, index);
      // Decode the scope object
      const scopeObject = deserializeObject(buffer, _index, options, false, headShape);
      // Adjust the index
      index = index + objectSize;

      // Check if field length is too short
      if (totalSize < 4 + 4 + objectSize + stringSize) {
        throw new BSONError('code_w_scope total size is too short, truncating scope');
      }

      // Check if totalSize field is too long
      if (totalSize > 4 + 4 + objectSize + stringSize) {
        throw new BSONError('code_w_scope total size is too long, clips outer document');
      }

      value = new Code(functionString, scopeObject);
    } else if (elementType === constants.BSON_DATA_DBPOINTER) {
      // Get the code string size
      const stringSize = NumberUtils.getInt32LE(buffer, index);
      index += 4;
      // Check if we have a valid string
      if (
        stringSize <= 0 ||
        stringSize > buffer.length - index ||
        buffer[index + stringSize - 1] !== 0
      )
        throw new BSONError('bad string length in bson');
      // Namespace
      const namespace = ByteUtils.toUTF8(buffer, index, index + stringSize - 1, shouldValidateKey);
      // Update parse index position
      index = index + stringSize;

      // Read the oid
      const oidBuffer = ByteUtils.allocateUnsafe(12);
      for (let i = 0; i < 12; i++) oidBuffer[i] = buffer[index + i];
      const oid = new ObjectId(oidBuffer);

      // Update the index
      index = index + 12;

      // Upgrade to DBRef type
      value = new DBRef(namespace, oid);
    } else {
      throw new BSONError(
        `Detected unknown BSON type ${elementType.toString(16)} for fieldname "${name}"`
      );
    }
    if (name === '__proto__') {
      Object.defineProperty(object, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true
      });
    } else {
      object[name] = value;
    }
  }

  // Check if the deserialization was against a valid array/object
  if (size !== index - startIndex) {
    if (isArray) throw new BSONError('corrupt array bson');
    throw new BSONError('corrupt object bson');
  }

  // if we did not find "$ref", "$id", "$db", or found an extraneous $key, don't make a DBRef
  if (isPossibleDBRef && isDBRefLike(object)) {
    const copy = Object.assign({}, object) as Partial<DBRefLike>;
    delete copy.$ref;
    delete copy.$id;
    delete copy.$db;
    return [new DBRef(object.$ref, object.$id, object.$db, copy), shape];
  }

  return [object, shape];
}
