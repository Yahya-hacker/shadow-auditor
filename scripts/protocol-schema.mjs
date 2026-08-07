/* eslint-disable perfectionist/sort-objects */

const PROTOCOL_VERSION = '1.0'
const SCHEMA_BASE = 'https://shadow-auditor.dev/protocol/1.0/schemas/'

export function schemaFileName(name) {
	return `${name
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replaceAll(/([A-Z])([A-Z][a-z])/g, '$1-$2')
		.toLowerCase()}.schema.json`
}

const ref = (name) => ({$ref: `./${schemaFileName(name)}`})
const nullableRef = (name) => ({oneOf: [ref(name), {type: 'null'}]})
const string = (options = {}) => ({type: 'string', ...options})
const integer = (options = {}) => ({type: 'integer', ...options})
const number = (options = {}) => ({type: 'number', ...options})
const boolean = () => ({type: 'boolean'})
const array = (items, options = {}) => ({type: 'array', items, ...options})
const strictObject = (properties, options = {}) => ({
	type: 'object',
	additionalProperties: false,
	properties,
	required: options.required ?? Object.keys(properties),
	...(options.maxProperties ? {maxProperties: options.maxProperties} : {}),
})
const enumString = (...values) => ({type: 'string', enum: values})
const timestamp = () => string({format: 'date-time', maxLength: 64})
const uuid = () => string({format: 'uuid', maxLength: 36})
const digest = () => ref('Digest')
const signature = () => ref('Signature')

const definitions = {
	JsonValue: {
		description: 'A bounded, recursively JSON-serializable value.',
		oneOf: [
			{type: 'null'},
			{type: 'boolean'},
			{type: 'number'},
			string({maxLength: 1_048_576}),
			array(ref('JsonValue'), {maxItems: 4096}),
			{type: 'object', additionalProperties: ref('JsonValue'), maxProperties: 1024},
		],
	},
	JsonObject: {
		description: 'A bounded JSON object with no non-JSON runtime values.',
		type: 'object',
		additionalProperties: ref('JsonValue'),
		maxProperties: 1024,
	},
	ProtocolVersion: {
		description: 'The frozen public protocol major/minor identifier.',
		type: 'string',
		const: PROTOCOL_VERSION,
	},
	Digest: {
		description: 'A lowercase SHA-256 digest with an explicit algorithm prefix.',
		type: 'string',
		pattern: '^sha256:[a-f0-9]{64}$',
		maxLength: 71,
	},
	Signature: {
		description: 'An unpadded base64url-encoded Ed25519 signature.',
		type: 'string',
		pattern: '^[A-Za-z0-9_-]{86}$',
		maxLength: 86,
	},
	SignedRequestMetadata: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		deviceId: uuid(),
		keyId: string({minLength: 1, maxLength: 128}),
		requestId: uuid(),
		timestamp: timestamp(),
		nonce: string({minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$'}),
		method: enumString('GET', 'POST'),
		path: string({minLength: 1, maxLength: 2048, pattern: '^/'}),
		bodyDigest: digest(),
		signatureAlgorithm: {type: 'string', const: 'ed25519'},
		signature: signature(),
	}),
	ProblemError: strictObject({
		pointer: string({minLength: 1, maxLength: 2048}),
		code: string({minLength: 1, maxLength: 128}),
		detail: string({minLength: 1, maxLength: 4096}),
	}),
	Problem: strictObject(
		{
			type: string({format: 'uri-reference', minLength: 1, maxLength: 2048}),
			title: string({minLength: 1, maxLength: 256}),
			status: integer({minimum: 100, maximum: 599}),
			detail: string({maxLength: 16_384}),
			instance: string({format: 'uri-reference', maxLength: 2048}),
			code: string({minLength: 1, maxLength: 128}),
			retryable: boolean(),
			traceId: string({minLength: 1, maxLength: 128}),
			errors: array(ref('ProblemError'), {maxItems: 128}),
		},
		{required: ['type', 'title', 'status', 'code', 'retryable']},
	),
	PublicKey: strictObject({
		algorithm: {type: 'string', const: 'ed25519'},
		keyId: string({minLength: 1, maxLength: 128}),
		publicKey: string({minLength: 43, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$'}),
	}),
	ToolDescriptor: strictObject({
		name: string({minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9._-]+$'}),
		description: string({minLength: 1, maxLength: 1024}),
		inputSchemaDigest: digest(),
		risk: enumString('read', 'write', 'execute', 'network', 'privileged'),
		maxResultBytes: integer({minimum: 0, maximum: 16_777_216}),
	}),
	DeviceEnrollmentRequest: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		enrollmentCode: string({minLength: 8, maxLength: 512}),
		deviceName: string({minLength: 1, maxLength: 128}),
		clientVersion: string({minLength: 1, maxLength: 64}),
		platform: enumString('linux', 'darwin', 'win32'),
		devicePublicKey: ref('PublicKey'),
	}),
	TokenSet: strictObject({
		tokenType: {type: 'string', const: 'Bearer'},
		accessToken: string({minLength: 32, maxLength: 8192}),
		accessTokenExpiresAt: timestamp(),
		refreshToken: string({minLength: 32, maxLength: 8192}),
		refreshTokenExpiresAt: timestamp(),
	}),
	DeviceEnrollmentResponse: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		deviceId: uuid(),
		tokens: ref('TokenSet'),
		serverTime: timestamp(),
		serverSigningKeys: array(ref('PublicKey'), {minItems: 1, maxItems: 16}),
	}),
	DeviceRefreshRequest: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		deviceId: uuid(),
		refreshToken: string({minLength: 32, maxLength: 8192}),
		request: ref('SignedRequestMetadata'),
	}),
	DeviceRefreshResponse: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		deviceId: uuid(),
		tokens: ref('TokenSet'),
		serverTime: timestamp(),
	}),
	ClientCapabilities: strictObject({
		protocolVersions: array(ref('ProtocolVersion'), {minItems: 1, maxItems: 8, uniqueItems: true}),
		features: array(
			enumString(
				'durable-events',
				'event-hash-chain',
				'local-tool-execution',
				'resumable-sessions',
				'digest-bound-approvals',
				'sse',
			),
			{minItems: 1, maxItems: 32, uniqueItems: true},
		),
		maxInboundEventBytes: integer({minimum: 1024, maximum: 16_777_216}),
		maxOutboundPayloadBytes: integer({minimum: 1024, maximum: 16_777_216}),
		tools: array(ref('ToolDescriptor'), {maxItems: 256}),
	}),
	ServerCapabilities: strictObject({
		protocolVersions: array(ref('ProtocolVersion'), {minItems: 1, maxItems: 8, uniqueItems: true}),
		features: array(
			enumString(
				'durable-events',
				'event-hash-chain',
				'local-tool-execution',
				'resumable-sessions',
				'digest-bound-approvals',
				'sse',
			),
			{minItems: 1, maxItems: 32, uniqueItems: true},
		),
		maxInboundPayloadBytes: integer({minimum: 1024, maximum: 16_777_216}),
		maxOutboundEventBytes: integer({minimum: 1024, maximum: 16_777_216}),
		heartbeatIntervalMs: integer({minimum: 1000, maximum: 300_000}),
		eventRetentionSeconds: integer({minimum: 60, maximum: 31_536_000}),
		signingKeys: array(ref('PublicKey'), {minItems: 1, maxItems: 16}),
	}),
	CapabilityNegotiationRequest: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		client: ref('ClientCapabilities'),
		request: ref('SignedRequestMetadata'),
	}),
	NegotiatedCapabilities: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		features: array(
			enumString(
				'durable-events',
				'event-hash-chain',
				'local-tool-execution',
				'resumable-sessions',
				'digest-bound-approvals',
				'sse',
			),
			{minItems: 1, maxItems: 32, uniqueItems: true},
		),
		maxClientPayloadBytes: integer({minimum: 1024, maximum: 16_777_216}),
		maxServerEventBytes: integer({minimum: 1024, maximum: 16_777_216}),
		heartbeatIntervalMs: integer({minimum: 1000, maximum: 300_000}),
		eventRetentionSeconds: integer({minimum: 60, maximum: 31_536_000}),
		tools: array(ref('ToolDescriptor'), {maxItems: 256}),
	}),
	CapabilityNegotiationResponse: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		negotiated: ref('NegotiatedCapabilities'),
		server: ref('ServerCapabilities'),
		negotiatedAt: timestamp(),
	}),
	ScanRequest: strictObject(
		{
			mode: enumString('audit', 'bounty', 'ci'),
			objective: string({minLength: 1, maxLength: 8192}),
			scope: array(string({minLength: 1, maxLength: 2048}), {minItems: 1, maxItems: 1024}),
			exclusions: array(string({minLength: 1, maxLength: 2048}), {maxItems: 1024}),
			baselineRevision: string({minLength: 1, maxLength: 256}),
			maxDurationSeconds: integer({minimum: 30, maximum: 604_800}),
		},
		{required: ['mode', 'objective', 'scope', 'exclusions']},
	),
	RepositoryDescriptor: strictObject({
		repositoryId: string({minLength: 1, maxLength: 256}),
		displayName: string({minLength: 1, maxLength: 256}),
		revision: string({minLength: 1, maxLength: 256}),
		dirty: boolean(),
		sourceMode: {type: 'string', const: 'tool-mediated'},
		semanticIndexDigest: digest(),
		repositoryMapDigest: digest(),
	}),
	CreateSessionRequest: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		clientRequestId: uuid(),
		repository: ref('RepositoryDescriptor'),
		scan: ref('ScanRequest'),
		capabilities: ref('NegotiatedCapabilities'),
		request: ref('SignedRequestMetadata'),
	}),
	UsageTotals: strictObject({
		inputTokens: integer({minimum: 0}),
		outputTokens: integer({minimum: 0}),
		toolExecutionMilliseconds: integer({minimum: 0}),
		storageBytes: integer({minimum: 0}),
	}),
	SessionSnapshot: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		sessionId: uuid(),
		status: enumString('created', 'running', 'paused', 'cancelling', 'cancelled', 'completed', 'failed'),
		cursor: integer({minimum: 0}),
		createdAt: timestamp(),
		updatedAt: timestamp(),
		scan: ref('ScanRequest'),
		negotiatedCapabilities: ref('NegotiatedCapabilities'),
		lastEventHash: nullableRef('Digest'),
		pendingToolProposalIds: array(uuid(), {maxItems: 256, uniqueItems: true}),
		usage: ref('UsageTotals'),
	}),
	EventEnvelope: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		eventId: uuid(),
		sessionId: uuid(),
		sequence: integer({minimum: 1}),
		occurredAt: timestamp(),
		eventType: enumString(
			'session.snapshot',
			'agent.action',
			'tool.proposal',
			'execution.grant',
			'usage.record',
			'session.paused',
			'session.resumed',
			'session.cancelled',
			'session.completed',
			'session.failed',
			'heartbeat',
		),
		correlationId: uuid(),
		causationId: nullableRef('Digest'),
		payload: ref('JsonObject'),
		payloadDigest: digest(),
		previousEventHash: nullableRef('Digest'),
		eventHash: digest(),
		signer: ref('PublicKey'),
		signature: signature(),
	}),
	ToolProposal: strictObject(
		{
			proposalId: uuid(),
			actionId: uuid(),
			sessionId: uuid(),
			toolName: string({minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9._-]+$'}),
			arguments: ref('JsonObject'),
			argumentsDigest: digest(),
			risk: enumString('read', 'write', 'execute', 'network', 'privileged'),
			reason: string({minLength: 1, maxLength: 8192}),
			requestedAt: timestamp(),
			expiresAt: timestamp(),
			idempotencyKey: string({minLength: 16, maxLength: 128}),
		},
		{
			required: [
				'proposalId',
				'actionId',
				'sessionId',
				'toolName',
				'arguments',
				'argumentsDigest',
				'risk',
				'reason',
				'requestedAt',
				'idempotencyKey',
			],
		},
	),
	AgentAction: strictObject(
		{
			actionId: uuid(),
			sessionId: uuid(),
			kind: enumString('analysis', 'propose_tool', 'progress', 'report', 'completed', 'failed'),
			summary: string({minLength: 1, maxLength: 16_384}),
			toolProposal: ref('ToolProposal'),
			data: ref('JsonObject'),
		},
		{required: ['actionId', 'sessionId', 'kind', 'summary', 'data']},
	),
	ToolDecision: strictObject(
		{
			protocolVersion: ref('ProtocolVersion'),
			decisionId: uuid(),
			sessionId: uuid(),
			proposalId: uuid(),
			decision: enumString('approve', 'deny'),
			decidedAt: timestamp(),
			actor: enumString('human', 'policy'),
			argumentsDigest: digest(),
			reason: string({maxLength: 8192}),
			constraints: ref('JsonObject'),
			request: ref('SignedRequestMetadata'),
		},
		{
			required: [
				'protocolVersion',
				'decisionId',
				'sessionId',
				'proposalId',
				'decision',
				'decidedAt',
				'actor',
				'argumentsDigest',
				'request',
			],
		},
	),
	ExecutionGrant: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		grantId: uuid(),
		sessionId: uuid(),
		proposalId: uuid(),
		decisionId: uuid(),
		deviceId: uuid(),
		toolName: string({minLength: 1, maxLength: 128}),
		argumentsDigest: digest(),
		decisionDigest: digest(),
		issuedAt: timestamp(),
		expiresAt: timestamp(),
		nonce: string({minLength: 16, maxLength: 128}),
		signer: ref('PublicKey'),
		signature: signature(),
	}),
	ToolResult: strictObject(
		{
			protocolVersion: ref('ProtocolVersion'),
			resultId: uuid(),
			sessionId: uuid(),
			proposalId: uuid(),
			grantId: uuid(),
			grantDigest: digest(),
			argumentsDigest: digest(),
			startedAt: timestamp(),
			completedAt: timestamp(),
			status: enumString('succeeded', 'failed', 'denied', 'cancelled'),
			output: ref('JsonValue'),
			outputDigest: digest(),
			error: ref('Problem'),
			truncated: boolean(),
			originalByteLength: integer({minimum: 0, maximum: 1_073_741_824}),
			request: ref('SignedRequestMetadata'),
		},
		{
			required: [
				'protocolVersion',
				'resultId',
				'sessionId',
				'proposalId',
				'grantId',
				'grantDigest',
				'argumentsDigest',
				'startedAt',
				'completedAt',
				'status',
				'outputDigest',
				'truncated',
				'originalByteLength',
				'request',
			],
		},
	),
	UsageRecord: strictObject(
		{
			protocolVersion: ref('ProtocolVersion'),
			usageId: uuid(),
			sessionId: uuid(),
			eventId: uuid(),
			occurredAt: timestamp(),
			meter: enumString('input_tokens', 'output_tokens', 'tool_execution_ms', 'storage_bytes'),
			quantity: number({minimum: 0}),
			unit: enumString('token', 'millisecond', 'byte'),
			billable: boolean(),
			source: string({minLength: 1, maxLength: 128}),
			metadata: ref('JsonObject'),
		},
		{
			required: [
				'protocolVersion',
				'usageId',
				'sessionId',
				'eventId',
				'occurredAt',
				'meter',
				'quantity',
				'unit',
				'billable',
				'source',
			],
		},
	),
	PauseSessionRequest: strictObject(
		{
			protocolVersion: ref('ProtocolVersion'),
			reason: string({maxLength: 4096}),
			request: ref('SignedRequestMetadata'),
		},
		{required: ['protocolVersion', 'request']},
	),
	ResumeSessionRequest: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		cursor: integer({minimum: 0}),
		lastEventHash: nullableRef('Digest'),
		request: ref('SignedRequestMetadata'),
	}),
	CancelSessionRequest: strictObject(
		{
			protocolVersion: ref('ProtocolVersion'),
			reason: string({maxLength: 4096}),
			request: ref('SignedRequestMetadata'),
		},
		{required: ['protocolVersion', 'request']},
	),
	SessionControlResponse: strictObject({
		protocolVersion: ref('ProtocolVersion'),
		sessionId: uuid(),
		status: enumString('running', 'paused', 'cancelling', 'cancelled'),
		effectiveAt: timestamp(),
		cursor: integer({minimum: 0}),
	}),
	HealthResponse: strictObject({
		status: enumString('ok', 'degraded'),
		protocolVersion: ref('ProtocolVersion'),
		serverTime: timestamp(),
	}),
	ReadinessCheck: strictObject({
		name: string({minLength: 1, maxLength: 128}),
		status: enumString('ready', 'not_ready'),
		detail: string({maxLength: 2048}),
	}),
	ReadinessResponse: strictObject({
		status: enumString('ready', 'not_ready'),
		protocolVersion: ref('ProtocolVersion'),
		serverTime: timestamp(),
		checks: array(ref('ReadinessCheck'), {maxItems: 64}),
	}),
}

export const schemas = Object.fromEntries(
	Object.entries(definitions).map(([name, body]) => [
		name,
		{
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			$id: `${SCHEMA_BASE}${schemaFileName(name)}`,
			title: name,
			...body,
		},
	]),
)

const schemaRef = (name) => ({$ref: `./schemas/${schemaFileName(name)}`})
const jsonContent = (name) => ({
	'application/json': {
		schema: schemaRef(name),
	},
})
const problemResponses = {
	'400': {description: 'Invalid request', content: jsonContent('Problem')},
	'401': {description: 'Authentication or request signature failed', content: jsonContent('Problem')},
	'409': {description: 'Replay, digest, cursor, or session-state conflict', content: jsonContent('Problem')},
	'413': {description: 'Payload exceeds negotiated bounds', content: jsonContent('Problem')},
	'429': {description: 'Backpressure limit exceeded', content: jsonContent('Problem')},
	'500': {description: 'Server failure', content: jsonContent('Problem')},
}
const signedSecurity = [{bearerAuth: [], requestSignature: []}]
const sessionParameter = {
	name: 'sessionId',
	in: 'path',
	required: true,
	schema: {type: 'string', format: 'uuid'},
}

export const openapi = {
	openapi: '3.1.0',
	info: {
		title: 'Shadow Auditor Public Remote Protocol',
		version: '1.0.0',
		description:
			'Frozen protocol 1.0 contract. Agent cognition remains server-side; local evidence, tools, approvals, and reports use purpose-built DTOs and never serialize LangGraph AgentState.',
	},
	jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
	servers: [{url: 'https://api.shadow-auditor.dev'}],
	'x-protocol-version': PROTOCOL_VERSION,
	paths: {
		'/healthz': {
			get: {
				operationId: 'getHealth',
				responses: {'200': {description: 'Liveness response', content: jsonContent('HealthResponse')}},
			},
		},
		'/readyz': {
			get: {
				operationId: 'getReadiness',
				responses: {'200': {description: 'Readiness response', content: jsonContent('ReadinessResponse')}},
			},
		},
		'/v1/auth/device/enroll': {
			post: {
				operationId: 'enrollDevice',
				requestBody: {required: true, content: jsonContent('DeviceEnrollmentRequest')},
				responses: {
					'201': {description: 'Device enrolled', content: jsonContent('DeviceEnrollmentResponse')},
					...problemResponses,
				},
			},
		},
		'/v1/auth/device/refresh': {
			post: {
				operationId: 'refreshDeviceToken',
				requestBody: {required: true, content: jsonContent('DeviceRefreshRequest')},
				responses: {
					'200': {description: 'Tokens rotated', content: jsonContent('DeviceRefreshResponse')},
					...problemResponses,
				},
			},
		},
		'/v1/capabilities/negotiate': {
			post: {
				operationId: 'negotiateCapabilities',
				security: signedSecurity,
				requestBody: {required: true, content: jsonContent('CapabilityNegotiationRequest')},
				responses: {
					'200': {description: 'Capabilities negotiated', content: jsonContent('CapabilityNegotiationResponse')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions': {
			post: {
				operationId: 'createSession',
				security: signedSecurity,
				requestBody: {required: true, content: jsonContent('CreateSessionRequest')},
				responses: {
					'201': {description: 'Session created', content: jsonContent('SessionSnapshot')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}': {
			get: {
				operationId: 'getSession',
				security: signedSecurity,
				parameters: [sessionParameter],
				responses: {
					'200': {description: 'Durable session snapshot', content: jsonContent('SessionSnapshot')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/events': {
			get: {
				operationId: 'streamSessionEvents',
				security: signedSecurity,
				parameters: [
					sessionParameter,
					{
						name: 'Last-Event-ID',
						in: 'header',
						required: false,
						schema: {type: 'string', format: 'uuid'},
					},
					{
						name: 'cursor',
						in: 'query',
						required: true,
						schema: {type: 'integer', minimum: 0},
					},
				],
				responses: {
					'200': {
						description: 'SSE stream. Each data field is one compact EventEnvelope JSON value.',
						content: {
							'text/event-stream': {
								schema: {type: 'string'},
								'x-sse-event-schema': schemaRef('EventEnvelope'),
							},
						},
					},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/tool-decisions': {
			post: {
				operationId: 'submitToolDecision',
				security: signedSecurity,
				parameters: [sessionParameter],
				requestBody: {required: true, content: jsonContent('ToolDecision')},
				responses: {
					'202': {description: 'Decision accepted', content: jsonContent('SessionSnapshot')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/tool-results': {
			post: {
				operationId: 'submitToolResult',
				security: signedSecurity,
				parameters: [sessionParameter],
				requestBody: {required: true, content: jsonContent('ToolResult')},
				responses: {
					'202': {description: 'Result accepted', content: jsonContent('SessionSnapshot')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/pause': {
			post: {
				operationId: 'pauseSession',
				security: signedSecurity,
				parameters: [sessionParameter],
				requestBody: {required: true, content: jsonContent('PauseSessionRequest')},
				responses: {
					'200': {description: 'Pause applied', content: jsonContent('SessionControlResponse')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/resume': {
			post: {
				operationId: 'resumeSession',
				security: signedSecurity,
				parameters: [sessionParameter],
				requestBody: {required: true, content: jsonContent('ResumeSessionRequest')},
				responses: {
					'200': {description: 'Resume applied', content: jsonContent('SessionControlResponse')},
					...problemResponses,
				},
			},
		},
		'/v1/sessions/{sessionId}/cancel': {
			post: {
				operationId: 'cancelSession',
				security: signedSecurity,
				parameters: [sessionParameter],
				requestBody: {required: true, content: jsonContent('CancelSessionRequest')},
				responses: {
					'200': {description: 'Cancellation accepted', content: jsonContent('SessionControlResponse')},
					...problemResponses,
				},
			},
		},
	},
	components: {
		securitySchemes: {
			bearerAuth: {type: 'http', scheme: 'bearer'},
			requestSignature: {
				type: 'apiKey',
				in: 'header',
				name: 'X-Shadow-Signature',
				description:
					'Ed25519 request signature. Replay metadata and the same signature are carried in SignedRequestMetadata.',
			},
		},
		schemas: Object.fromEntries(Object.keys(schemas).map((name) => [name, schemaRef(name)])),
	},
}

export {PROTOCOL_VERSION}
