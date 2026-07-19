import { z } from "zod";

const Schema = z.object({
  PORT: z.string().optional().default("3000").transform(Number),
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  REDIS_URL: z.string().url(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  // Path to a local clone of rome-protocol/rome-registry. Required: chain metadata
  // (chainIds, contract addresses, gas mints, bridge wiring) is canonical there —
  // the registry is the single source of truth.
  // Boot-time required so a misconfigured deploy fails fast instead of 500-ing
  // at first /v1/chains hit.
  REGISTRY_PATH: z.string().min(1, "REGISTRY_PATH must be set to the absolute path of a local registry clone"),
  // Solana RPC URL (use a dedicated endpoint; the public api.devnet.solana.com
  // is rate-limited). Read-only: the quote flow reads the rome-evm program's OwnerInfo
  // PDA to resolve each chain's gas mint (authoritative source; the registry is
  // a mirror that can drift). Optional — routes that need it fail closed / fall
  // back to the registry mirror with a warning when it's unset.
  SOLANA_RPC_URL: z.string().url().optional(),
  // Rome networks whose PRIMARY program the DEFAULT chain scope walks
  // (/v1/chains + /v1/quote resolve chains from these). Comma-separated.
  // Default "testnet,mainnet" (public service). A DEVNET deployment sets
  // "devnet,testnet,mainnet" (or "devnet") so it serves devnet chains like
  // Hadrian. Rome network → Solana cluster is a SEPARATE axis: devnet always
  // maps to solana-devnet, and testnet is usually solana-devnet too, so a
  // solana-devnet deployment can serve devnet + testnet primaries at once.
  PRIMARY_NETWORKS: z.string().optional(),
});

export interface Config {
  port: number;
  env: "development" | "test" | "staging" | "production";
  redisUrl: string;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  registryPath: string;
  solanaRpcUrl?: string | undefined;
  primaryNetworks: string[];
}

/**
 * Resolve the default chain-scope network list from PRIMARY_NETWORKS, falling
 * back to testnet+mainnet when unset/empty. Read directly by RegistryClient so
 * the scope doesn't have to thread through every construction site.
 */
export function resolvePrimaryNetworks(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = (env.PRIMARY_NETWORKS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : ["testnet", "mainnet"];
}

export function loadConfig(): Config {
  const parsed = Schema.parse(process.env);
  return {
    port: parsed.PORT,
    env: parsed.NODE_ENV,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    registryPath: parsed.REGISTRY_PATH,
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    primaryNetworks: resolvePrimaryNetworks(process.env),
  };
}
