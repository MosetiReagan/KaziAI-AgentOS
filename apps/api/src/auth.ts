import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  safeEqual,
  sha256,
  type ApiKey,
  type Logger,
  type Organization,
  type Principal,
  type Project,
  type Role,
} from '@kazi-ai/agentos-core';
import type { AgentOSStore } from '@kazi-ai/agentos-persistence';
import { forbidden, unauthorized } from './errors.js';

/** Keys look like `kz_live_ab12cd34.<32 bytes of secret>`; the prefix is the lookup key. */
export const KEY_MARKER = 'kz_live_';
const SECRET_BYTES = 24;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `key_...` identifiers for API keys; ids are opaque, the prefix is the lookup. */
function newKeyId(now: number): string {
  return `key_${(now * 1000 + Math.floor(Math.random() * 1000)).toString(36)}${randomToken(4)}`;
}

export interface MintedApiKey {
  plaintext: string;
  prefix: string;
  hash: string;
}

function randomToken(bytes: number): string {
  const buffer = randomBytes(bytes);
  let out = '';
  for (const byte of buffer) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Generate a key. Only the hash and the prefix are ever stored (spec §66). */
export function mintApiKey(): MintedApiKey {
  const prefix = `${KEY_MARKER}${randomToken(6)}`;
  const secret = randomToken(SECRET_BYTES);
  const plaintext = `${prefix}.${secret}`;
  return { plaintext, prefix, hash: sha256(plaintext) };
}

/**
 * Recompute the stored fingerprint of a key. `sha256` of the whole plaintext is
 * sufficient here because the secret is 24 random bytes: there is nothing to
 * guess, so no per-key salt is needed.
 */
export function hashApiKey(plaintext: string): string {
  return sha256(plaintext);
}

export interface ApiKeyAuthenticatorOptions {
  store: AgentOSStore;
  /** Environment-provided fixed key, mainly for CI. */
  bootstrapKey?: string;
  /** Tenant used when authentication is disabled and for the bootstrap key. */
  organizationId: string;
  projectId: string;
  logger?: Logger;
  now?: () => number;
}

/**
 * Bearer-token authentication against the durable key store (spec §64).
 *
 * Nothing about a request is trusted until it resolves to a key record whose
 * hash matches, and a principal never carries more than the key it came from.
 */
export class ApiKeyAuthenticator {
  private readonly now: () => number;

  constructor(private readonly options: ApiKeyAuthenticatorOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Resolve the caller, or throw a 401 that says nothing useful to an attacker. */
  async authenticate(request: FastifyRequest): Promise<Principal> {
    const header = request.headers.authorization;
    if (!header) throw unauthorized('Provide an API key as "Authorization: Bearer <key>"');
    const [scheme, ...rest] = header.split(' ');
    const presented = rest.join(' ').trim();
    if (!scheme || scheme.toLowerCase() !== 'bearer' || presented.length === 0) {
      throw unauthorized('Authorization header must be "Bearer <key>"');
    }
    return this.authenticateKey(presented);
  }

  async authenticateKey(presented: string): Promise<Principal> {
    const separator = presented.indexOf('.');
    if (separator <= 0) throw unauthorized('That API key is not valid');
    const prefix = presented.slice(0, separator);
    const record = await this.options.store.identity.apiKeys.getByPrefix(prefix);
    if (!record) throw unauthorized('That API key is not valid');
    if (record.revokedAt !== undefined) throw unauthorized('That API key has been revoked');
    if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
      throw unauthorized('That API key has expired');
    }
    if (!safeEqual(hashApiKey(presented), record.hash)) {
      throw unauthorized('That API key is not valid');
    }
    await this.touch(record);
    return principalFromKey(record);
  }

  /**
   * Create the tenant and first admin key when the deployment has none, so a
   * fresh install is not locked out. The plaintext is returned exactly once.
   */
  async bootstrap(): Promise<{ created: boolean; organizationId: string; projectId: string; key?: string }> {
    const { store } = this.options;
    const organizations = await store.identity.organizations.list();
    if (organizations.length > 0) {
      const existing = await store.identity.apiKeys.list(this.options.organizationId);
      if (existing.length > 0) {
        return {
          created: false,
          organizationId: this.options.organizationId,
          projectId: this.options.projectId,
        };
      }
    }

    const organizationId = this.options.organizationId;
    const projectId = this.options.projectId;
    const now = this.now();
    if (!(await store.identity.organizations.get(organizationId))) {
      const organization: Organization = {
        id: organizationId,
        name: organizationId,
        slug: organizationId.replace(/^org_/, ''),
        createdAt: now,
      };
      await store.identity.organizations.save(organization);
    }
    if (!(await store.identity.projects.get(projectId))) {
      const project: Project = {
        id: projectId,
        organizationId,
        name: projectId,
        slug: projectId.replace(/^prj_/, ''),
        createdAt: now,
      };
      await store.identity.projects.save(project);
    }

    const minted = this.options.bootstrapKey
      ? {
          plaintext: this.options.bootstrapKey,
          prefix: this.options.bootstrapKey.slice(0, this.options.bootstrapKey.indexOf('.')),
          hash: hashApiKey(this.options.bootstrapKey),
        }
      : mintApiKey();
    await store.identity.apiKeys.save({
      id: newKeyId(now),
      organizationId,
      projectId,
      name: 'bootstrap',
      hash: minted.hash,
      prefix: minted.prefix,
      role: 'admin',
      createdAt: now,
    });
    this.options.logger?.info('created the bootstrap organization and API key', {
      organizationId,
      projectId,
    });
    return { created: true, organizationId, projectId, key: minted.plaintext };
  }

  /** Create an additional key for a tenant. The plaintext is never persisted. */
  async create(input: {
    organizationId: string;
    projectId?: string;
    name: string;
    role: Role;
    expiresAt?: number;
  }): Promise<{ key: string; record: ApiKey }> {
    const minted = mintApiKey();
    const now = this.now();
    const record: ApiKey = {
      id: newKeyId(now),
      organizationId: input.organizationId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      name: input.name,
      hash: minted.hash,
      prefix: minted.prefix,
      role: input.role,
      createdAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    await this.options.store.identity.apiKeys.save(record);
    return { key: minted.plaintext, record };
  }

  async revoke(keyId: string, organizationId: string): Promise<ApiKey> {
    const record = await this.options.store.identity.apiKeys.get(keyId);
    if (!record || record.organizationId !== organizationId) {
      throw forbidden('That API key does not belong to this organization', { keyId });
    }
    const updated: ApiKey = { ...record, revokedAt: this.now() };
    await this.options.store.identity.apiKeys.save(updated);
    return updated;
  }

  /** Trim the write-back of `lastUsedAt` so a hot key does not churn storage. */
  private async touch(record: ApiKey): Promise<void> {
    const now = this.now();
    if (record.lastUsedAt !== undefined && now - record.lastUsedAt < 60_000) return;
    await this.options.store.identity.apiKeys.save({ ...record, lastUsedAt: now });
  }
}

export function principalFromKey(record: ApiKey): Principal {
  return {
    kind: 'api-key',
    id: record.id,
    organizationId: record.organizationId,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    role: record.role,
  };
}

/** The implicit principal used only when authentication is explicitly disabled. */
export function localPrincipal(organizationId: string, projectId: string): Principal {
  return {
    kind: 'service-account',
    id: 'local-operator',
    organizationId,
    projectId,
    role: 'admin',
  };
}
