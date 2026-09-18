import type { HttpProxy } from './proxy.js';

export interface UpstreamHealth {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  detail?: string;
  durationMs: number;
}

/**
 * Ask each upstream whether it is ready. The gateway's own readiness is only as
 * good as the dependencies it fronts, so no upstream that owns traffic is
 * allowed to fail silently.
 */
export async function checkUpstreams(
  proxies: HttpProxy[],
  timeoutMs = 2_000,
): Promise<UpstreamHealth[]> {
  return Promise.all(
    proxies.map(async (proxy) => {
      const startedAt = Date.now();
      const origin = proxy.origin;
      if (proxy.readyPath === false) {
        return { name: proxy.name, url: origin, ok: true, durationMs: 0 };
      }
      const target = `${origin}${proxy.readyPath}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(target, { signal: controller.signal });
        return {
          name: proxy.name,
          url: origin,
          ok: response.ok,
          status: response.status,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          name: proxy.name,
          url: origin,
          ok: false,
          detail: (error as Error).name === 'AbortError' ? 'timeout' : (error as Error).message,
          durationMs: Date.now() - startedAt,
        };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
