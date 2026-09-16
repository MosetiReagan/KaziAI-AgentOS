import { describe, expect, it } from 'vitest';
import { createJsonSchemaInput, validateAgainstSchema } from '../src/json-schema.js';

describe('JSON Schema validation of MCP arguments', () => {
  const schema = {
    type: 'object',
    properties: {
      message: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      mode: { enum: ['fast', 'slow'] },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      nested: { type: 'object', properties: { deep: { type: 'boolean' } }, required: ['deep'] },
      retries: { type: 'integer', default: 3 },
    },
    required: ['message'],
    additionalProperties: false,
  };

  it('accepts a payload that satisfies the published schema', () => {
    const result = validateAgainstSchema(schema, { message: 'hi', count: 3, mode: 'fast', tags: ['a'] });
    expect(result.valid).toBe(true);
  });

  it('rejects the keyword violations servers rely on', () => {
    const missingRequired = validateAgainstSchema(schema, {});
    expect(missingRequired.valid).toBe(false);
    if (!missingRequired.valid) expect(missingRequired.issues[0]?.path).toBe('$.message');

    const badType = validateAgainstSchema(schema, { message: 'hi', count: 'three' });
    expect(badType.valid).toBe(false);

    const outOfRange = validateAgainstSchema(schema, { message: 'hi', count: 99 });
    expect(outOfRange.valid).toBe(false);

    const badEnum = validateAgainstSchema(schema, { message: 'hi', mode: 'medium' });
    expect(badEnum.valid).toBe(false);

    const extra = validateAgainstSchema(schema, { message: 'hi', surprise: true });
    expect(extra.valid).toBe(false);
    if (!extra.valid) expect(extra.issues.some((issue) => issue.message.includes('not an allowed property'))).toBe(true);
  });

  it('validates nested objects and array items', () => {
    const nested = validateAgainstSchema(schema, { message: 'hi', nested: {} });
    expect(nested.valid).toBe(false);
    if (!nested.valid) expect(nested.issues[0]?.path).toBe('$.nested.deep');

    const items = validateAgainstSchema(schema, { message: 'hi', tags: [1] });
    expect(items.valid).toBe(false);
    if (!items.valid) expect(items.issues[0]?.path).toBe('$.tags[0]');
  });

  it('fills documented defaults so the server sees what it published', () => {
    const result = validateAgainstSchema(schema, { message: 'hi' });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual({ message: 'hi', retries: 3 });
  });

  it('exposes the tool-facing InputSchema contract', () => {
    const input = createJsonSchemaInput(schema);
    expect(input.safeParse({ message: 'hi' }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(() => input.parse({})).toThrow(/message is required/);
    expect(input.toJsonSchema?.()).toBe(schema);
  });

  it('honours anyOf and const', () => {
    const either = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    expect(validateAgainstSchema(either, 'text').valid).toBe(true);
    expect(validateAgainstSchema(either, 4).valid).toBe(true);
    expect(validateAgainstSchema(either, true).valid).toBe(false);
    expect(validateAgainstSchema({ const: 'fixed' }, 'fixed').valid).toBe(true);
    expect(validateAgainstSchema({ const: 'fixed' }, 'other').valid).toBe(false);
  });
});
