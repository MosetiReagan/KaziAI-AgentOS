import type { JsonObject } from '../json.js';

export type Role = 'admin' | 'operator' | 'developer' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  settings?: JsonObject;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: number;
  settings?: JsonObject;
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  name?: string;
  role: Role;
  createdAt: number;
  disabled?: boolean;
}

export interface ApiKey {
  id: string;
  organizationId: string;
  projectId?: string;
  name: string;
  /** Only the hash is persisted; the plaintext is shown once at creation. */
  hash: string;
  prefix: string;
  role: Role;
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
}

export interface Principal {
  kind: 'user' | 'api-key' | 'service-account';
  id: string;
  organizationId: string;
  projectId?: string;
  role: Role;
  scopes?: string[];
}

export interface SecretProvider {
  get(name: string): Promise<string>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  has(name: string): Promise<boolean>;
  list?(): Promise<string[]>;
}

