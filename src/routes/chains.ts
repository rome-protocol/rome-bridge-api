import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { ChainInventory, InvalidProgramIdError } from "../chains/inventory.js";
import { bridgeError } from "../errors.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Decorated by buildApp (production) or by tests (mocked).
     * When present, GET /v1/chains and GET /v1/chains/{chainId} use it as the
     * authoritative source. Default scope = testnet + mainnet primaries; the
     * `?programId=` query param overrides to a specific registered program.
     */
    chainInventory?: ChainInventory;
  }
}

export async function chainsRoutes(app: FastifyInstance, cfg: Config) {
  const client = new RegistryClient({
    source: { kind: "local", path: cfg.registryPath },
  });
  const cached = new CachedRegistry(client, 60_000);

  app.get<{ Querystring: { programId?: string } }>("/chains", async (req, reply) => {
    if (app.chainInventory) {
      try {
        const programId = req.query.programId;
        const chains = await app.chainInventory.listChains(programId ? { programId } : {});
        return { chains };
      } catch (e) {
        if (e instanceof InvalidProgramIdError) {
          reply.status(400);
          return { ...bridgeError("rome.bridge.program-id-unknown",
            `programId '${e.programId}' is not registered`) };
        }
        throw e;
      }
    }
    return { chains: await cached.listChains() };
  });

  app.get<{ Params: { chainId: string }; Querystring: { programId?: string } }>(
    "/chains/:chainId",
    async (req, reply) => {
      if (!app.chainInventory) {
        reply.status(503);
        return { ...bridgeError("rome.bridge.asset-not-supported", "chain inventory not initialized") };
      }
      const raw = req.params.chainId;
      if (!/^\d+$/.test(raw)) {
        reply.status(400);
        return { ...bridgeError("rome.bridge.request-invalid",
          `chainId must be a positive integer; got '${raw}'`) };
      }

      const programId = req.query.programId;
      let matches;
      try {
        matches = await app.chainInventory.getChainsByChainId(
          BigInt(raw), programId ? { programId } : {},
        );
      } catch (e) {
        if (e instanceof InvalidProgramIdError) {
          reply.status(400);
          return { ...bridgeError("rome.bridge.program-id-unknown",
            `programId '${e.programId}' is not registered`) };
        }
        throw e;
      }

      if (matches.length === 0) {
        reply.status(404);
        const detail = programId
          ? `chainId ${raw} not registered on program ${programId}`
          : `chainId ${raw} not registered on any external rome-evm primary (testnet or mainnet); ` +
            `query with ?programId=<base58> to search a specific program`;
        return { ...bridgeError("rome.bridge.asset-not-supported", detail) };
      }
      if (matches.length === 1) return matches[0];

      // Collision between the testnet primary and mainnet primary — extremely
      // rare in practice (live chainIds typically don't overlap across rome
      // networks) but the path stays correct under future drift.
      reply.status(409);
      return {
        ...bridgeError(
          "rome.bridge.chain-id-ambiguous",
          `chainId ${raw} is registered on ${matches.length} programs; ` +
            `specify ?programId=<base58> to disambiguate`,
          { candidates: matches.map((m) => ({ programId: m.programId, network: m.network, name: m.name })) },
        ),
      };
    },
  );
}
