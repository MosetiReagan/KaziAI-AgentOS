/**
 * The dispatcher contract lives in the runtime because it belongs to execution,
 * not to HTTP: the API accepts runs, the worker drains them, and both agree on
 * one interface. Re-exported here so API code has a single import site.
 */
export { InProcessDispatcher } from '@kazi-ai/agentos-runtime';
export type {
  DispatchAction,
  DispatchContext,
  RunDispatcher,
} from '@kazi-ai/agentos-runtime';
