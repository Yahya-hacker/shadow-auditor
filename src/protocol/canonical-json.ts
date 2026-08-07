import {createHash} from 'node:crypto'

import type {JsonValue} from './generated.js'

function assertPlainObject(value: object): asserts value is Record<string, JsonValue> {
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError('Canonical JSON accepts only plain objects')
	}
}

export function canonicalizeJson(value: JsonValue): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value)
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers')
		return JSON.stringify(Object.is(value, -0) ? 0 : value)
	}

	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalizeJson(entry)).join(',')}]`
	}

	assertPlainObject(value)
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
		.join(',')}}`
}

export function canonicalJsonBytes(value: JsonValue): Buffer {
	return Buffer.from(canonicalizeJson(value), 'utf8')
}

export function sha256Digest(value: Buffer | JsonValue | string): string {
	const bytes =
		typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJsonBytes(value)
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
