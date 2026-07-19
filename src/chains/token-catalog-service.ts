/**
 * /v1/tokens factory long-tail reader. Returns the mint-keyed set the background
 * factory indexer (token-factory-indexer.ts) maintains in Redis under
 * `tokencat:factory:<chainId>`. There is NO getLogs on the request path — the
 * indexer paginates off-path (Rome caps eth_getLogs at 12k blocks). An absent
 * set (indexer cold, or no redis) ⇒ [], so the catalog degrades to the
 * registry-verified tokens and never 500s.
 */
import type { ChainConfig } from "../registry/types.js";
import type { FactoryTokenInput } from "./token-catalog.js";

/** Minimal redis surface (ioredis Redis and test fakes both satisfy it). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
}

export interface FactoryTokensDeps {
  redis?: RedisLike | undefined;
}

export type FactoryTokensFor = (chain: ChainConfig) => Promise<FactoryTokenInput[]>;

export function makeFactoryTokensFor(deps: FactoryTokensDeps = {}): FactoryTokensFor {
  return async (chain: ChainConfig): Promise<FactoryTokenInput[]> => {
    if (!deps.redis) return [];
    const raw = await deps.redis.get(`tokencat:factory:${chain.chainId}`);
    return raw ? (JSON.parse(raw) as FactoryTokenInput[]) : [];
  };
}
