import { FastifyInstance } from "fastify";
import { ROUTE_SPECS } from "../route-builders/route-keys.js";

export async function assetsRoutes(app: FastifyInstance) {
  // Concrete fixed-asset routes only. The asset-agnostic meta-rails (SPL =
  // Solana-native, TOKEN = generic Wormhole egress) require an explicit
  // mint/wrapper via /v1/quote splAsset, so they're not static catalog assets.
  app.get("/assets", async () => ({ routes: Object.values(ROUTE_SPECS).filter((r) => r.asset !== "SPL" && r.asset !== "TOKEN") }));
}
