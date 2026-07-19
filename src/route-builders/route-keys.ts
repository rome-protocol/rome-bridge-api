import { bridgeError } from "../errors.js";

export type Direction = "to-rome" | "from-rome";
// "SPL" is the asset-agnostic rail: ANY Solana SPL (LSTs like mSOL/bSOL, or any
// factory-minted token). The concrete mint + decimals ride on QuoteInput.splAsset
// rather than being baked into a per-asset builder.
// "SPL" = Solana-native rail (any SPL/LST in+out via Solana). "TOKEN" = generic
// Wormhole egress (any wrapped asset Rome→L2 via burnToWormhole), asset-agnostic
// + per-call destination; the concrete wrapper + Wormhole targetChain ride on the
// request. Both keep the fixed USDC/ETH/SOL rails untouched.
export type Asset = "USDC" | "ETH" | "SOL" | "SPL" | "TOKEN";

export const ROUTE_KEYS = [
  "usdc-cctp-to-rome",
  "usdc-cctp-from-rome",
  "usdc-solana-to-rome",
  "usdc-solana-from-rome",
  "eth-wormhole-to-rome",
  "eth-wormhole-from-rome",
  "sol-solana-to-rome",
  "sol-solana-from-rome",
  "spl-solana-to-rome",
  "spl-solana-from-rome",
  "token-wormhole-from-rome",
] as const;
export type RouteKey = (typeof ROUTE_KEYS)[number];

export interface RouteSpec {
  key: RouteKey;
  asset: Asset;
  direction: Direction;
  sourceChain: "ethereum" | "solana" | "rome";
  decimals: number;
  minAmount: string;
  maxAmount: string;
}

export const ROUTE_SPECS: Record<RouteKey, RouteSpec> = {
  "usdc-cctp-to-rome":     { key: "usdc-cctp-to-rome",     asset: "USDC", direction: "to-rome",   sourceChain: "ethereum", decimals: 6,  minAmount: "1000000",             maxAmount: "100000000000" },
  "usdc-cctp-from-rome":   { key: "usdc-cctp-from-rome",   asset: "USDC", direction: "from-rome", sourceChain: "rome",     decimals: 6,  minAmount: "1000000",             maxAmount: "100000000000" },
  "usdc-solana-to-rome":   { key: "usdc-solana-to-rome",   asset: "USDC", direction: "to-rome",   sourceChain: "solana",   decimals: 6,  minAmount: "1000000",             maxAmount: "100000000000" },
  "usdc-solana-from-rome": { key: "usdc-solana-from-rome", asset: "USDC", direction: "from-rome", sourceChain: "rome",     decimals: 6,  minAmount: "1000000",             maxAmount: "100000000000" },
  "eth-wormhole-to-rome":  { key: "eth-wormhole-to-rome",  asset: "ETH",  direction: "to-rome",   sourceChain: "ethereum", decimals: 18, minAmount: "1000000000000000",    maxAmount: "100000000000000000000" },
  "eth-wormhole-from-rome":{ key: "eth-wormhole-from-rome",asset: "ETH",  direction: "from-rome", sourceChain: "rome",     decimals: 18, minAmount: "1000000000000000",    maxAmount: "100000000000000000000" },
  "sol-solana-to-rome":    { key: "sol-solana-to-rome",    asset: "SOL",  direction: "to-rome",   sourceChain: "solana",   decimals: 9,  minAmount: "10000000",            maxAmount: "10000000000000" },
  "sol-solana-from-rome":  { key: "sol-solana-from-rome",  asset: "SOL",  direction: "from-rome", sourceChain: "rome",     decimals: 9,  minAmount: "10000000",            maxAmount: "10000000000000" },
  // Asset-agnostic SPL rail. `decimals` here is the nominal LST default (9); the
  // authoritative per-asset decimals ride on QuoteInput.splAsset.decimals and the
  // builder binds transferChecked to it. Bounds are wide (base units) so any LST
  // dust amount is admissible.
  "spl-solana-to-rome":    { key: "spl-solana-to-rome",    asset: "SPL",  direction: "to-rome",   sourceChain: "solana",   decimals: 9,  minAmount: "1",                   maxAmount: "1000000000000000000" },
  "spl-solana-from-rome":  { key: "spl-solana-from-rome",  asset: "SPL",  direction: "from-rome", sourceChain: "rome",     decimals: 9,  minAmount: "1",                   maxAmount: "1000000000000000000" },
  // Generic Wormhole egress: Rome → any allowlisted L2, any allowlisted wrapper.
  // sourceChain "ethereum" = the destination is an EVM chain (reached via Wormhole).
  "token-wormhole-from-rome": { key: "token-wormhole-from-rome", asset: "TOKEN", direction: "from-rome", sourceChain: "ethereum", decimals: 9, minAmount: "1", maxAmount: "1000000000000000000" },
};

/**
 * The route floor, scoped by the Rome chain's network. minAmount exists to
 * protect MAINNET users from net-negative bridges (destination-side gas
 * exceeds the delivered value). On devnet/testnet chains value is play money
 * and dust-probing a route with a tiny amount is the standard first test, so
 * the floor collapses to 1 base unit (never 0 — a zero-amount burn/transfer
 * is degenerate downstream). A chain with NO network field keeps the mainnet
 * floor: registry drift must not silently drop the guardrail. maxAmount (the
 * blast-radius cap) applies on every network.
 */
export function effectiveMinAmount(
  spec: RouteSpec,
  chain: { network?: string | undefined },
): string {
  return chain.network && chain.network !== "mainnet" ? "1" : spec.minAmount;
}

/** Shared amount gate used by every route builder. */
export function assertAmountInRange(
  spec: RouteSpec,
  input: { amount: string; chain: { network?: string | undefined } },
): void {
  const amount = BigInt(input.amount);
  const min = effectiveMinAmount(spec, input.chain);
  if (amount < BigInt(min) || amount > BigInt(spec.maxAmount)) {
    throw bridgeError("rome.bridge.amount-out-of-range",
      `amount ${input.amount} outside [${min}, ${spec.maxAmount}]`);
  }
}
