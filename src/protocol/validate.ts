import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { problem, ProtocolError } from './protocol-error.js';

const schemaDirectory = fileURLToPath(new URL('../../protocol/schemas/', import.meta.url));
const ajv = new Ajv2020({
  allErrors: true,
  formats: {
    'date-time': (value: string) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(Date.parse(value)),
    'uri-reference': (value: string) =>
      Array.from(value).every((character) => (character.codePointAt(0) ?? 0) > 0x20),
    uuid: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  },
  strict: true,
});

const validators = new Map<string, ValidateFunction>();
const schemas = fs.readdirSync(schemaDirectory)
  .filter((name) => name.endsWith('.schema.json'))
  .map((fileName) => ({
    fileName,
    schema: JSON.parse(fs.readFileSync(path.join(schemaDirectory, fileName), 'utf8')) as {
      $id: string;
    },
  }));
for (const { schema } of schemas) ajv.addSchema(schema);
for (const { fileName, schema } of schemas) {
  const validate = ajv.getSchema(schema.$id);
  if (!validate) throw new Error(`Protocol validator failed to compile ${fileName}`);
  validators.set(fileName, validate);
}

export type ProtocolSchemaName =
  | 'agent-action.schema.json'
  | 'cancel-session-request.schema.json'
  | 'capability-negotiation-request.schema.json'
  | 'capability-negotiation-response.schema.json'
  | 'create-session-request.schema.json'
  | 'device-enrollment-request.schema.json'
  | 'device-enrollment-response.schema.json'
  | 'device-refresh-request.schema.json'
  | 'device-refresh-response.schema.json'
  | 'event-envelope.schema.json'
  | 'execution-grant.schema.json'
  | 'health-response.schema.json'
  | 'pause-session-request.schema.json'
  | 'problem.schema.json'
  | 'readiness-response.schema.json'
  | 'resume-session-request.schema.json'
  | 'session-control-response.schema.json'
  | 'session-snapshot.schema.json'
  | 'tool-decision.schema.json'
  | 'tool-proposal.schema.json'
  | 'tool-result.schema.json'
  | 'usage-record.schema.json';

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
    .join('; ');
}

export function validateProtocolDto<T>(schemaName: ProtocolSchemaName, value: unknown): T {
  const validate = validators.get(schemaName);
  if (!validate) throw new Error(`Protocol validator is unavailable for ${schemaName}`);
  if (!validate(value)) {
    throw new ProtocolError(problem({
      code: 'INVALID_PROTOCOL_DTO',
      detail: `${schemaName}: ${formatErrors(validate.errors)}`,
      status: 422,
      title: 'Protocol payload failed strict schema validation',
    }));
  }

  return value as T;
}
