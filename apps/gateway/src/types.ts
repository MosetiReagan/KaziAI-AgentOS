import type { Logger } from '@kazi-ai/agentos-core';

export interface GatewayUpstream {
  /** A label used in logs, health output and errors. */
  name: string;
  /** Absolute origin, e.g. `http://127.0.0.1:4000`. */
  url: string;
  /** Path prefixes this upstream owns. `/` matches everything. */
  prefixes: string[];
  /** Readiness path on this upstream; `false` skips it in `/readyz`. */
  readyPath?: string | false;
  /** How long a proxied request may take before the gateway gives up. */
  timeoutMs?: number;
}

export interface GatewayOptions {
  /** Route table, ordered most specific first. The first match wins. */
  upstreams: GatewayUpstream[];
  /** Upstream used for paths no other route claims, when there is one. */
  fallback?: GatewayUpstream;
  host?: string;
  port?: number;
  /** Maximum proxied requests in flight before `RESOURCE_EXHAUSTED` (spec §83). */
  maxInFlight?: number;
  logger?: Logger;
  /** Adds `access-control-allow-origin` to proxied responses when set. */
  corsOrigin?: string;
}

export interface GatewayHandle {
  server: import('node:http').Server;
  url: string;
  host: string;
  port: number;
  /** The effective route table, as served. */
  routes: GatewayRouteView[];
  stop(): Promise<void>;
}

export interface GatewayRouteView {
  name: string;
  url: string;
  prefixes: string[];
  readyPath?: string | false;
}
