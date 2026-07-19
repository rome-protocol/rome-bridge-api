import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { buildTokenList } from "../chains/token-catalog.js";
import type { FactoryTokensFor } from "../chains/token-catalog-service.js";
import { bridgeError } from "../errors.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Per-chain factory-token fetch (getLogs + Redis cache). Decorated by
     * buildApp in prod; tests inject a mock. Absent ⇒ registry-only catalog.
     */
    factoryTokensFor?: FactoryTokensFor;
  }
}

/**
 * GET /v1/tokens?chainId=<romeChainId> — the mint-keyed token catalog for a
 * chain: registry tokens.json (verified) ∪ on-chain factory long-tail (unverified),
 * each `{ mint, symbol, decimals, verified, wrappers[] }`. Mint is the identity.
 */
export async function tokensRoutes(app: FastifyInstance, cfg: Config) {
  const cached = new CachedRegistry(
    new RegistryClient({ source: { kind: "local", path: cfg.registryPath } }),
    60_000,
  );

  app.get<{ Querystring: { chainId?: string } }>("/tokens", async (req, reply) => {
    const chainId = req.query.chainId;
    if (!chainId) {
      const e = bridgeError("rome.bridge.asset-not-supported", "chainId query param is required");
      reply.status(e.status);
      return e;
    }
    const chain = (await cached.listChains()).find((c) => c.chainId === chainId);
    if (!chain) {
      const e = bridgeError("rome.bridge.asset-not-supported", `unknown chainId ${chainId}`);
      reply.status(e.status);
      return e;
    }
    const factoryTokens = app.factoryTokensFor ? await app.factoryTokensFor(chain) : [];
    return { chainId, tokens: buildTokenList(chain.tokens ?? [], factoryTokens) };
  });
}
