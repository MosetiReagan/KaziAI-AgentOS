import type { InputSchema, JsonObject, JsonValue } from '@kazi-ai/agentos-core';

export interface ValidationIssue {
  path: string;
  message: string;
}

export type SchemaValidation = { valid: true; value: JsonValue } | { valid: false; issues: ValidationIssue[] };

/**
 * Validates MCP tool arguments against the JSON Schema the server published.
 *
 * MCP servers describe their tools with JSON Schema, while AgentOS tools expose
 * a `parse`/`safeParse` contract. This is a real (if deliberately small)
 * validator covering the keywords servers actually use, so a malformed call is
 * rejected in-process instead of being forwarded to a remote service.
 */
export function validateAgainstSchema(schema: unknown, input: unknown): SchemaValidation {
  const issues: ValidationIssue[] = [];
  const value = applyDefaults(schema, input, issues, '$');
  validate(schema, value, issues, '$');
  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, value: value as JsonValue };
}

export function createJsonSchemaInput(schema: unknown): InputSchema {
  const jsonSchema = (typeof schema === 'object' && schema !== null ? schema : { type: 'object' }) as JsonObject;
  return {
    parse(input: unknown): unknown {
      const result = validateAgainstSchema(schema, input);
      if (!result.valid) {
        throw new Error(result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '));
      }
      return result.value;
    },
    safeParse(input: unknown) {
      const result = validateAgainstSchema(schema, input);
      if (result.valid) return { success: true, data: result.value };
      return {
        success: false,
        error: { message: result.issues.map((issue) => `${issue.path} ${issue.message}`).join('; '), issues: result.issues },
      };
    },
    toJsonSchema(): JsonObject {
      return jsonSchema;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fill in declared defaults so servers see the arguments they documented. */
function applyDefaults(schema: unknown, input: unknown, issues: ValidationIssue[], path: string): unknown {
  if (!isRecord(schema)) return input;
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
  if (schema['type'] === 'object' && properties) {
    const target: Record<string, unknown> = isRecord(input) ? { ...input } : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (target[key] === undefined && isRecord(propertySchema) && propertySchema['default'] !== undefined) {
        target[key] = propertySchema['default'];
      }
      if (target[key] !== undefined) {
        target[key] = applyDefaults(propertySchema, target[key], issues, `${path}.${key}`);
      }
    }
    return target;
  }
  if (schema['type'] === 'array' && Array.isArray(input) && schema['items'] !== undefined) {
    return input.map((item, index) => applyDefaults(schema['items'], item, issues, `${path}[${index}]`));
  }
  return input;
}

function validate(schema: unknown, value: unknown, issues: ValidationIssue[], path: string): void {
  if (!isRecord(schema)) return;
  if (schema['const'] !== undefined && JSON.stringify(schema['const']) !== JSON.stringify(value)) {
    issues.push({ path, message: `must equal ${JSON.stringify(schema['const'])}` });
    return;
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    issues.push({ path, message: `must be one of ${schema['enum'].map((item) => JSON.stringify(item)).join(', ')}` });
    return;
  }
  const alternatives = [schema['anyOf'], schema['oneOf']].find((candidate) => Array.isArray(candidate));
  if (Array.isArray(alternatives)) {
    const matches = alternatives.filter((candidate) => validateAgainstSchema(candidate, value).valid);
    if (matches.length === 0) issues.push({ path, message: 'does not match any allowed schema' });
    if (Array.isArray(schema['oneOf']) && matches.length > 1) issues.push({ path, message: 'matches more than one schema' });
    return;
  }

  const expected = schema['type'];
  if (typeof expected === 'string' && !matchesType(expected, value)) {
    issues.push({ path, message: `must be ${expected === 'integer' ? 'an integer' : `a ${expected}`}` });
    return;
  }

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) issues.push({ path, message: `must be at least ${schema['minLength']} characters` });
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) issues.push({ path, message: `must be at most ${schema['maxLength']} characters` });
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) issues.push({ path, message: `must match ${schema['pattern']}` });
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) issues.push({ path, message: `must be >= ${schema['minimum']}` });
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) issues.push({ path, message: `must be <= ${schema['maximum']}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) issues.push({ path, message: `must have at least ${schema['minItems']} items` });
    if (schema['items'] !== undefined) {
      value.forEach((item, index) => validate(schema['items'], item, issues, `${path}[${index}]`));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? schema['required'].filter((key): key is string => typeof key === 'string') : [];
    for (const key of required) {
      if (value[key] === undefined) issues.push({ path: `${path}.${key}`, message: 'is required' });
    }
    for (const [key, item] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        validate(propertySchema, item, issues, `${path}.${key}`);
      } else if (schema['additionalProperties'] === false && schema['patternProperties'] === undefined) {
        issues.push({ path: `${path}.${key}`, message: 'is not an allowed property' });
      }
    }
  }
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}
