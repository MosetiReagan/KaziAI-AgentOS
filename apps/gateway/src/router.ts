import type { HttpProxy } from './proxy.js';

export interface GatewayRoute {
  proxy: HttpProxy;
}

/**
 * Longest-prefix matching. Prefixes are compared on path segment boundaries so
 * `/apiary` is not captured by a route that owns `/api`.
 */
export class GatewayRouter {
  private readonly routes: GatewayRoute[];
  private readonly catchAll: GatewayRoute | undefined;

  constructor(proxies: HttpProxy[], fallback?: HttpProxy) {
    const ordered = [...proxies].sort((left, right) => longest(left) - longest(right)).reverse();
    this.routes = ordered
      .filter((proxy) => !proxy.prefixes.includes('/'))
      .map((proxy) => ({ proxy }));
    this.catchAll = fallback
      ? { proxy: fallback }
      : (proxies.find((proxy) => proxy.prefixes.includes('/')) === undefined
          ? undefined
          : { proxy: proxies.find((proxy) => proxy.prefixes.includes('/')) as HttpProxy });
  }

  match(pathname: string): GatewayRoute | undefined {
    const path = pathname.length === 0 ? '/' : pathname;
    for (const route of this.routes) {
      if (route.proxy.prefixes.some((prefix) => matches(path, prefix))) return route;
    }
    return this.catchAll;
  }

  /** Every route the gateway can serve, in match order. */
  list(): GatewayRoute[] {
    return this.catchAll ? [...this.routes, this.catchAll] : [...this.routes];
  }
}

function longest(proxy: HttpProxy): number {
  return proxy.prefixes.reduce((length, prefix) => Math.max(length, prefix.length), 0);
}

export function matches(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}
