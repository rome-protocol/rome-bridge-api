import { buildUsdcCctpInboundQuote, Quote, QuoteInput } from "./usdc-cctp-inbound.js";
import { buildUsdcCctpOutboundQuote } from "./usdc-cctp-outbound.js";
import { buildUsdcSolanaInboundQuote } from "./usdc-solana-inbound.js";
import { buildUsdcSolanaOutboundQuote } from "./usdc-solana-outbound.js";
import { buildEthWormholeInboundQuote } from "./eth-wormhole-inbound.js";
import { buildEthWormholeOutboundQuote } from "./eth-wormhole-outbound.js";
import { buildSolSolanaInboundQuote } from "./sol-solana-inbound.js";
import { buildSolSolanaOutboundQuote } from "./sol-solana-outbound.js";
import { buildSplSolanaInboundQuote } from "./spl-solana-inbound.js";
import { buildSplSolanaOutboundQuote } from "./spl-solana-outbound.js";
import { buildTokenWormholeOutboundQuote } from "./token-wormhole-outbound.js";
import { Asset, Direction, RouteKey } from "./route-keys.js";

type Builder = (input: QuoteInput) => Quote;

const BUILDERS: Partial<Record<RouteKey, Builder>> = {
  "usdc-cctp-to-rome":      buildUsdcCctpInboundQuote,
  "usdc-cctp-from-rome":    buildUsdcCctpOutboundQuote,
  "usdc-solana-to-rome":    buildUsdcSolanaInboundQuote,
  "usdc-solana-from-rome":  buildUsdcSolanaOutboundQuote,
  "eth-wormhole-to-rome":   buildEthWormholeInboundQuote,
  "eth-wormhole-from-rome": buildEthWormholeOutboundQuote,
  "sol-solana-to-rome":     buildSolSolanaInboundQuote,
  "sol-solana-from-rome":   buildSolSolanaOutboundQuote,
  "spl-solana-to-rome":     buildSplSolanaInboundQuote,
  "spl-solana-from-rome":   buildSplSolanaOutboundQuote,
  "token-wormhole-from-rome": buildTokenWormholeOutboundQuote,
};

export function resolveRouteKey(asset: Asset, direction: Direction, sourceChain: string): RouteKey {
  if (asset === "USDC" && sourceChain === "ethereum") return direction === "to-rome" ? "usdc-cctp-to-rome" : "usdc-cctp-from-rome";
  if (asset === "USDC" && sourceChain === "solana")   return direction === "to-rome" ? "usdc-solana-to-rome" : "usdc-solana-from-rome";
  if (asset === "ETH"  && sourceChain === "ethereum") return direction === "to-rome" ? "eth-wormhole-to-rome" : "eth-wormhole-from-rome";
  if (asset === "SOL"  && sourceChain === "solana")   return direction === "to-rome" ? "sol-solana-to-rome" : "sol-solana-from-rome";
  if (asset === "SPL"  && sourceChain === "solana")   return direction === "to-rome" ? "spl-solana-to-rome" : "spl-solana-from-rome";
  // Generic Wormhole egress: any wrapped token Rome → an EVM L2. from-rome only.
  if (asset === "TOKEN" && direction === "from-rome" && sourceChain === "ethereum") return "token-wormhole-from-rome";
  throw new Error(`no route for ${asset}/${direction}/${sourceChain}`);
}

export function buildQuote(routeKey: RouteKey, input: QuoteInput): Quote {
  const builder = BUILDERS[routeKey];
  if (!builder) throw new Error(`route builder not implemented yet: ${routeKey}`);
  return builder(input);
}

export { RouteKey };
