import {createHash} from 'node:crypto';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | {[key: string]: JsonValue};

export interface CanonicalJsonLimits {
  maxArrayLength: number;
  maxDepth: number;
  maxNodes: number;
  maxObjectKeys: number;
  maxPayloadBytes: number;
  maxStringBytes: number;
}

export interface BoundedCanonicalJsonValidation {
  canonicalJson: string;
  nodeCount: number;
  payloadBytes: number;
  value: JsonValue;
}

export const PROTOCOL_CANONICAL_LIMITS: Readonly<CanonicalJsonLimits> = Object.freeze({
  maxArrayLength: 1024,
  maxDepth: 32,
  maxNodes: 10_000,
  maxObjectKeys: 256,
  maxPayloadBytes: 1_048_576,
  maxStringBytes: 65_536,
});

export class CanonicalJsonError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function fail(code: string, message: string): never {
  throw new CanonicalJsonError(code, message);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function validateUnicode(value: string, label: string, limits: CanonicalJsonLimits): void {
  if (byteLength(value) > limits.maxStringBytes) {
    fail('string_too_large', `${label} exceeds ${limits.maxStringBytes} UTF-8 bytes`);
  }

  for (let index = 0; index < value.length; index++) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    if (codePoint >= 0xD8_00 && codePoint <= 0xDF_FF) {
      fail('invalid_unicode', `${label} contains an unpaired UTF-16 surrogate`);
    }

    if (codePoint > 0xFF_FF) {
      index++;
    }
  }
}

function validateNumber(value: number): void {
  if (!Number.isFinite(value)) fail('invalid_number', 'numbers must be finite');
  if (Object.is(value, -0)) fail('invalid_number', 'negative zero is not permitted');
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    fail('unsafe_integer', 'integers must be within the I-JSON safe range');
  }
}

interface ValidationState {
  active: WeakSet<object>;
  limits: CanonicalJsonLimits;
  nodes: number;
}

function countNode(state: ValidationState, amount = 1): void {
  state.nodes += amount;
  if (state.nodes > state.limits.maxNodes) {
    fail('too_many_nodes', `JSON value exceeds ${state.limits.maxNodes} nodes`);
  }
}

// Snapshot through property descriptors so validation and serialization cover identical values.
// eslint-disable-next-line complexity
function snapshotJsonValue(value: unknown, depth: number, state: ValidationState): JsonValue {
  if (depth > state.limits.maxDepth) {
    fail('too_deep', `JSON value exceeds depth ${state.limits.maxDepth}`);
  }

  countNode(state);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    validateUnicode(value, 'string', state.limits);
    return value;
  }

  if (typeof value === 'number') {
    validateNumber(value);
    return value;
  }

  if (typeof value !== 'object') {
    fail('unsupported_type', `unsupported JSON value type: ${typeof value}`);
  }

  if (state.active.has(value)) fail('cyclic_value', 'cyclic JSON values are not permitted');
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > state.limits.maxArrayLength) {
        fail('array_too_large', `array exceeds ${state.limits.maxArrayLength} elements`);
      }

      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        fail('unsupported_property', 'symbol array properties are not permitted');
      }

      const permittedKeys = new Set(['length', ...Array.from({length: value.length}, (_, index) => String(index))]);
      if (ownKeys.some((key) => typeof key === 'string' && !permittedKeys.has(key))) {
        fail('unsupported_property', 'named array properties are not permitted');
      }

      const descriptors = Object.getOwnPropertyDescriptors(value);
      const snapshot: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[index];
        if (!descriptor) fail('sparse_array', 'sparse arrays are not permitted');
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          fail('unsupported_property', 'non-enumerable and accessor array elements are not permitted');
        }

        snapshot.push(snapshotJsonValue(descriptor.value, depth + 1, state));
      }

      return snapshot;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('unsupported_object', 'class instances and executable objects are not permitted');
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail('unsupported_property', 'symbol object properties are not permitted');
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > state.limits.maxObjectKeys) {
      fail('object_too_large', `object exceeds ${state.limits.maxObjectKeys} keys`);
    }

    countNode(state, keys.length);
    const snapshot: {[key: string]: JsonValue} = Object.create(null) as {[key: string]: JsonValue};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        fail('unsupported_property', 'non-enumerable and accessor properties are not permitted');
      }

      validateUnicode(key, 'object key', state.limits);
      snapshot[key] = snapshotJsonValue(descriptor.value, depth + 1, state);
    }

    return snapshot;
  } finally {
    state.active.delete(value);
  }
}

interface SerializationState {
  bytes: number;
  chunks: string[];
  maxPayloadBytes: number;
}

function appendCanonical(state: SerializationState, chunk: string): void {
  state.bytes += byteLength(chunk);
  if (state.bytes > state.maxPayloadBytes) {
    fail('payload_too_large', `canonical JSON exceeds ${state.maxPayloadBytes} bytes`);
  }

  state.chunks.push(chunk);
}

function serializeCanonical(value: JsonValue, state: SerializationState): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    appendCanonical(state, JSON.stringify(value));
    return;
  }

  if (Array.isArray(value)) {
    appendCanonical(state, '[');
    for (const [index, item] of value.entries()) {
      if (index > 0) appendCanonical(state, ',');
      serializeCanonical(item, state);
    }

    appendCanonical(state, ']');
    return;
  }

  appendCanonical(state, '{');
  for (const [index, key] of Object.keys(value).sort().entries()) {
    if (index > 0) appendCanonical(state, ',');
    appendCanonical(state, JSON.stringify(key));
    appendCanonical(state, ':');
    serializeCanonical(value[key], state);
  }

  appendCanonical(state, '}');
}

export function validateBoundedCanonicalJson(
  value: unknown,
  limits: CanonicalJsonLimits = PROTOCOL_CANONICAL_LIMITS,
): BoundedCanonicalJsonValidation {
  const state: ValidationState = {active: new WeakSet(), limits, nodes: 0};
  const snapshot = snapshotJsonValue(value, 0, state);
  const serialization: SerializationState = {
    bytes: 0,
    chunks: [],
    maxPayloadBytes: limits.maxPayloadBytes,
  };
  serializeCanonical(snapshot, serialization);
  const canonical = serialization.chunks.join('');

  return {
    canonicalJson: canonical,
    nodeCount: state.nodes,
    payloadBytes: serialization.bytes,
    value: snapshot,
  };
}

export function canonicalizeJson(
  value: unknown,
  limits: CanonicalJsonLimits = PROTOCOL_CANONICAL_LIMITS,
): string {
  return validateBoundedCanonicalJson(value, limits).canonicalJson;
}

class StrictJsonParser {
  private index = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    private readonly limits: CanonicalJsonLimits,
  ) {
    if (byteLength(source) > limits.maxPayloadBytes) {
      fail('payload_too_large', `JSON text exceeds ${limits.maxPayloadBytes} bytes`);
    }
  }

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.error('unexpected trailing input');
    return value;
  }

  private countNode(amount = 1): void {
    this.nodes += amount;
    if (this.nodes > this.limits.maxNodes) {
      fail('too_many_nodes', `JSON value exceeds ${this.limits.maxNodes} nodes`);
    }
  }

  private error(message: string): never {
    fail('invalid_json', `${message} at offset ${this.index}`);
  }

  private parseArray(depth: number): JsonValue[] {
    this.index++;
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === ']') {
      this.index++;
      return result;
    }

    while (true) {
      if (result.length >= this.limits.maxArrayLength) {
        fail('array_too_large', `array exceeds ${this.limits.maxArrayLength} elements`);
      }

      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const next = this.source[this.index++];
      if (next === ']') return result;
      if (next !== ',') this.error('expected comma or closing bracket');
      this.skipWhitespace();
      if (this.source[this.index] === ']') this.error('trailing commas are not permitted');
    }
  }

  private parseLiteral(literal: string, value: JsonPrimitive): JsonPrimitive {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      this.error(`expected ${literal}`);
    }

    this.index += literal.length;
    return value;
  }

  private parseNumber(): number {
    const remaining = this.source.slice(this.index);
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining)?.[0];
    if (!token) this.error('invalid number');
    const next = remaining[token.length];
    if (next && !/[\s,\]}]/.test(next)) this.error('invalid number delimiter');
    this.index += token.length;
    const value = Number(token);
    validateNumber(value);
    return value;
  }

  private parseObject(depth: number): {[key: string]: JsonValue} {
    this.index++;
    const result: {[key: string]: JsonValue} = Object.create(null) as {[key: string]: JsonValue};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === '}') {
      this.index++;
      return result;
    }

    while (true) {
      if (keys.size >= this.limits.maxObjectKeys) {
        fail('object_too_large', `object exceeds ${this.limits.maxObjectKeys} keys`);
      }

      if (this.source[this.index] !== '"') this.error('object keys must be strings');
      const key = this.parseString();
      if (keys.has(key)) fail('duplicate_key', `duplicate object key: ${key}`);
      keys.add(key);
      this.countNode();
      this.skipWhitespace();
      if (this.source[this.index++] !== ':') this.error('expected colon');
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const next = this.source[this.index++];
      if (next === '}') return result;
      if (next !== ',') this.error('expected comma or closing brace');
      this.skipWhitespace();
      if (this.source[this.index] === '}') this.error('trailing commas are not permitted');
    }
  }

  private parseString(): string {
    const start = this.index++;
    while (this.index < this.source.length) {
      const character = this.source.codePointAt(this.index)!;
      if (character === 0x22) {
        this.index++;
        const token = this.source.slice(start, this.index);
        let value: string;
        try {
          value = JSON.parse(token) as string;
        } catch {
          this.error('invalid string escape');
        }

        validateUnicode(value, 'string', this.limits);
        return value;
      }

      if (character < 0x20) this.error('unescaped control character');
      if (character === 0x5C) {
        this.index++;
        const escape = this.source[this.index];
        if (!escape || !String.raw`"\/bfnrtu`.includes(escape)) this.error('invalid string escape');
        if (escape === 'u') {
          const hexadecimal = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[\dA-Fa-f]{4}$/.test(hexadecimal)) this.error('invalid Unicode escape');
          this.index += 4;
        }
      }

      this.index++;
    }

    this.error('unterminated string');
  }

  private parseValue(depth: number): JsonValue {
    if (depth > this.limits.maxDepth) {
      fail('too_deep', `JSON value exceeds depth ${this.limits.maxDepth}`);
    }

    this.countNode();
    const character = this.source[this.index];
    if (character === '"') return this.parseString();
    if (character === '{') return this.parseObject(depth);
    if (character === '[') return this.parseArray(depth);
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    if (character === '-' || (character >= '0' && character <= '9')) return this.parseNumber();
    this.error('unexpected token');
  }

  private skipWhitespace(): void {
    while (/[\t\n\r ]/.test(this.source[this.index] ?? '')) this.index++;
  }
}

export function parseStrictJson(
  source: string,
  limits: CanonicalJsonLimits = PROTOCOL_CANONICAL_LIMITS,
): JsonValue {
  return new StrictJsonParser(source, limits).parse();
}

export function canonicalizeJsonText(
  source: string,
  limits: CanonicalJsonLimits = PROTOCOL_CANONICAL_LIMITS,
): string {
  return canonicalizeJson(parseStrictJson(source, limits), limits);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function digestCanonicalJson(
  value: unknown,
  limits: CanonicalJsonLimits = PROTOCOL_CANONICAL_LIMITS,
): string {
  return sha256Bytes(Buffer.from(canonicalizeJson(value, limits), 'utf8'));
}

export const EMPTY_BODY_SHA256 = sha256Bytes(new Uint8Array());
