/**
 * Per-chain bridge capabilities — the rails + constraints a client needs to know
 * beyond the enumerated asset list. Crucially advertises `spl: "any-mint"` so a
 * client knows it can bridge ANY SPL mint (via /v1/tokens + the SPL rail), not
 * just the curated assets.
 */

export interface ChainCapabilities {
  /** Rome↔Solana accepts ANY SPL mint (no allowlist) — the any-mint rail. */
  spl: "any-mint";
  gasMint: { solanaMint: string; symbol: string | null };
  /** Rails this chain supports, e.g. ["cctp","wormhole","spl-bridge","native"]. */
  rails: string[];
  /** EVM source chains available for CCTP inbound. */
  cctpSourceChainIds: number[];
  /** Assets bridged via Wormhole (the allowlisted egress rail). */
  wormholeAssets: { symbol: string; solanaMint: string }[];
}

interface CapBridgeAsset {
  symbol?: string | undefined;
  solanaMint?: string | undefined;
  // Loose: the registry's zod type carries a passthrough here; narrow at use.
  sourceEvm?: unknown;
}
export interface CapBridge {
  assets?: readonly CapBridgeAsset[] | undefined;
}

export function chainCapabilities(
  bridge: CapBridge | undefined | null,
  gasMint: { solanaMint: string; symbol: string | null },
): ChainCapabilities {
  const assets = bridge?.assets ?? [];
  const src = (a: CapBridgeAsset) => a.sourceEvm as { chainId?: number; protocol?: string } | undefined;
  const cctp = assets.filter((a) => src(a)?.protocol === "cctp");
  const wh = assets.filter((a) => src(a)?.protocol === "wormhole");

  const cctpSourceChainIds = [
    ...new Set(cctp.map((a) => src(a)?.chainId).filter((c): c is number => typeof c === "number")),
  ];
  const wormholeAssets = wh
    .filter((a) => a.symbol && a.solanaMint)
    .map((a) => ({ symbol: a.symbol as string, solanaMint: a.solanaMint as string }));

  const rails = [
    ...(cctp.length ? ["cctp"] : []),
    ...(wh.length ? ["wormhole"] : []),
    "spl-bridge", // Rome↔Solana any-mint transfer — always available
    "native", // gas-mint deposit/withdraw precompile
  ];

  return { spl: "any-mint", gasMint, rails, cctpSourceChainIds, wormholeAssets };
}
