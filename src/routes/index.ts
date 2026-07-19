import { FastifyInstance } from "fastify";
import { Config } from "../config.js";
import { healthRoutes } from "./health.js";
import { chainsRoutes } from "./chains.js";
import { assetsRoutes } from "./assets.js";
import { tokensRoutes } from "./tokens.js";
import { quoteRoutes } from "./quote.js";
import { transfersRoutes } from "./transfers.js";
import { routesMatrixRoutes, freshAttestationHealth } from "./routes-matrix.js";
import { openapiRoutes } from "./openapi.js";
import { workerRoutes } from "./worker.js";
import { solanaRoutes } from "./solana.js";

export async function registerRoutes(app: FastifyInstance, cfg: Config) {
  // Root-scoped so the poller (server-level) and /routes (v1 scope) share it.
  if (!app.hasDecorator("attestationHealth")) {
    app.decorate("attestationHealth", freshAttestationHealth());
  }
  await app.register(async (v1) => {
    await healthRoutes(v1, cfg);
    await chainsRoutes(v1, cfg);
    await assetsRoutes(v1);
    await tokensRoutes(v1, cfg);
    await routesMatrixRoutes(v1, cfg);
    await openapiRoutes(v1);
    await quoteRoutes(v1, cfg);
    await transfersRoutes(v1, cfg);
    await workerRoutes(v1);
    await solanaRoutes(v1, cfg);
  }, { prefix: "/v1" });
}
