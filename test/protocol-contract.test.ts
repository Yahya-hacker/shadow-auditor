import {Ajv2020} from 'ajv/dist/2020.js'
import {expect} from 'chai'
import {execFileSync} from 'node:child_process'
import {createHash, createPrivateKey, createPublicKey, verify} from 'node:crypto'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {JsonValue} from '../src/protocol/generated.js'

import {canonicalizeJson, sha256Digest} from '../src/protocol/canonical-json.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(path.join(root, 'protocol/manifest.json'), 'utf8')) as {
	contractDigest: string
	files: Record<string, string>
	protocolVersion: string
}
const vectors = JSON.parse(readFileSync(path.join(root, 'protocol/signing-vectors.json'), 'utf8')) as {
	canonicalization: Array<{canonical: string; digest: string; input: JsonValue;}>
	event: {canonical: string; digest: string; signature: string}
	key: {publicKey: string; seedHex: string}
	request: {canonical: string; digest: string; signature: string}
}

describe('protocol 1.0 contract', () => {
	it('has no generated drift', () => {
		execFileSync(process.execPath, ['./scripts/generate-protocol.mjs', '--check'], {
			cwd: root,
			stdio: 'pipe',
		})
	})

	it('matches every manifest digest and the aggregate contract digest', () => {
		const entries = Object.entries(manifest.files).sort(([left], [right]) => left.localeCompare(right))
		for (const [file, expected] of entries) {
			const actual = `sha256:${createHash('sha256')
				.update(readFileSync(path.join(root, file)))
				.digest('hex')}`
			expect(actual, file).to.equal(expected)
		}

		const contractInput = entries.map(([file, digest]) => `${file}:${digest}\n`).join('')
		expect(`sha256:${createHash('sha256').update(contractInput).digest('hex')}`).to.equal(
			manifest.contractDigest,
		)
		expect(manifest.protocolVersion).to.equal('1.0')
	})

	it('compiles every strict JSON Schema with Ajv 2020', () => {
		const ajv = new Ajv2020({
			allErrors: true,
			formats: {'date-time': true, 'uri-reference': true, uuid: true},
			strict: true,
		})
		const schemas = Object.keys(manifest.files)
			.filter((file) => file.startsWith('protocol/schemas/'))
			.map((file) => JSON.parse(readFileSync(path.join(root, file), 'utf8')))
		for (const schema of schemas) ajv.addSchema(schema)
		for (const schema of schemas) expect(ajv.getSchema(schema.$id), schema.title).to.be.a('function')
	})

	it('keeps all DTO object shapes closed', () => {
		const visit = (value: unknown, location: string): void => {
			if (!value || typeof value !== 'object') return
			if (Array.isArray(value)) {
				for (const [index, child] of value.entries()) visit(child, `${location}/${index}`)
				return
			}

			const record = value as Record<string, unknown>
			if (record.type === 'object' && record.properties) {
				expect(record.additionalProperties, location).to.equal(false)
			}

			for (const [key, child] of Object.entries(record)) visit(child, `${location}/${key}`)
		}

		for (const file of Object.keys(manifest.files).filter((entry) =>
			entry.startsWith('protocol/schemas/'),
		)) {
			visit(JSON.parse(readFileSync(path.join(root, file), 'utf8')), file)
		}
	})

	it('reproduces canonicalization and SHA-256 vectors', () => {
		for (const vector of vectors.canonicalization) {
			expect(canonicalizeJson(vector.input)).to.equal(vector.canonical)
			expect(sha256Digest(vector.input)).to.equal(vector.digest)
		}
	})

	it('verifies deterministic Ed25519 request and event signatures', () => {
		const seed = Buffer.from(vectors.key.seedHex, 'hex')
		const privateKey = createPrivateKey({
			format: 'der',
			key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
			type: 'pkcs8',
		})
		const publicKey = createPublicKey(privateKey)
		expect(publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64url')).to.equal(
			vectors.key.publicKey,
		)

		for (const vector of [vectors.request, vectors.event]) {
			expect(sha256Digest(vector.canonical)).to.equal(vector.digest)
			expect(
				verify(
					null,
					Buffer.from(vector.canonical, 'utf8'),
					publicKey,
					Buffer.from(vector.signature, 'base64url'),
				),
			).to.equal(true)
		}
	})
})
