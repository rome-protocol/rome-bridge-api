/**
 * Source-chain catalog over the registry's published bridge.json shape
 *.
 *
 * The published shape is hybrid: a legacy single `sourceEvm{}` (the chain's
 * default source) AND a `sourceEvms[]` catalog may both be present. The merged
 * catalog is [legacy, ...sourceEvms] deduplicated by chainId (first wins).
 *
 * Published naming convention (verified against registry main): on pure-V2
 * entries the legacy-named fields carry V2 values (`cctpTokenMessenger ==
 * cctpTokenMessengerV2`); on entries with V1 history (Sepolia) the legacy
 * fields are the real V1 contracts. Address resolution is therefore
 * version-keyed, never name-keyed.
 */

export interface SourceEvmEntry {
  chainId: number;
  name?: string | undefined;
  rpcUrl?: string | undefined;
  explorerUrl?: string | undefined;
  cctpVersion?: number | undefined;
  cctpDomain?: number | undefined;
  cctpTokenMessenger?: string | undefined;
  cctpTokenMessengerV2?: string | undefined;
  cctpMessageTransmitter?: string | undefined;
  cctpMessageTransmitterV2?: string | undefined;
  wormholeChainId?: number | undefined;
  wormholeTokenBridge?: string | undefined;
  wormholeCoreBridge?: string | undefined;
  [k: string]: unknown;
}

export interface BridgeAssetRow {
  id?: string | undefined;
  symbol: string;
  solanaMint: string;
  decimals?: number | undefined;
  name?: string | undefined;
  sourceEvm?: {
    chainId?: number | undefined;
    address?: string | undefined;
    protocol?: string | undefined;
    cctpVersion?: number | undefined;
    [k: string]: unknown;
  } | undefined;
  [k: string]: unknown;
}

export interface BridgeLike {
  sourceEvm?: SourceEvmEntry | undefined;
  sourceEvms?: SourceEvmEntry[] | undefined;
  assets?: BridgeAssetRow[] | undefined;
  solana?: { cctpDomain?: number | undefined; [k: string]: unknown } | undefined;
  cctpIrisApiBase?: string | undefined;
  [k: string]: unknown;
}

/** Legacy entry first (it is the chain's default source), then the catalog; dedup by chainId, first wins. */
export function mergedCatalog(bridge: BridgeLike | undefined): SourceEvmEntry[] {
  if (!bridge) return [];
  const seen = new Set<number>();
  const out: SourceEvmEntry[] = [];
  for (const entry of [bridge.sourceEvm, ...(bridge.sourceEvms ?? [])]) {
    if (!entry || typeof entry.chainId !== "number") continue;
    if (seen.has(entry.chainId)) continue;
    seen.add(entry.chainId);
    out.push(entry);
  }
  return out;
}

/** chainId omitted ⇒ the chain's default source (merged entry 0). Unknown ⇒ undefined (caller fails closed). */
export function entryFor(bridge: BridgeLike | undefined, chainId?: number): SourceEvmEntry | undefined {
  const catalog = mergedCatalog(bridge);
  if (chainId === undefined) return catalog[0];
  return catalog.find((e) => e.chainId === chainId);
}

/**
 * Asset rows bind to a source via the per-asset `sourceEvm.chainId`; a row
 * without it belongs to the chain's default source (merged entry 0).
 */
export function assetFor(
  bridge: BridgeLike | undefined,
  q: { symbol?: string; assetId?: string; sourceChainId?: number },
): BridgeAssetRow | undefined {
  const assets = bridge?.assets ?? [];
  const defaultChainId = mergedCatalog(bridge)[0]?.chainId;
  const wanted = q.sourceChainId ?? defaultChainId;
  return assets.find((a) => {
    if (q.assetId !== undefined && a.id !== q.assetId) return false;
    if (q.assetId === undefined && q.symbol !== undefined && a.symbol !== q.symbol) return false;
    const bound = a.sourceEvm?.chainId ?? defaultChainId;
    return bound === wanted;
  });
}

/** Per-asset override > entry default > 1. Values outside {1,2} are refused (fail closed). */
export function cctpVersionFor(entry: SourceEvmEntry, asset?: BridgeAssetRow): 1 | 2 {
  const v = asset?.sourceEvm?.cctpVersion ?? entry.cctpVersion ?? 1;
  if (v !== 1 && v !== 2) throw new Error(`unsupported cctpVersion ${v} on source chain ${entry.chainId}`);
  return v;
}

/**
 * A pure-V2 entry never had V1: its legacy-named fields hold V2 values.
 * Distinguisher: declared V2 and no *distinct* legacy messenger.
 */
export function isPureV2Entry(entry: SourceEvmEntry): boolean {
  if (entry.cctpVersion !== 2) return false;
  return !entry.cctpTokenMessenger || entry.cctpTokenMessenger === entry.cctpTokenMessengerV2;
}

export interface CctpAddresses {
  tokenMessenger: string | undefined;
  messageTransmitter: string | undefined;
}

/** Version-keyed address resolution. Missing pieces stay undefined — callers fail closed. */
export function resolveCctpAddresses(entry: SourceEvmEntry, version: 1 | 2): CctpAddresses {
  const pureV2 = isPureV2Entry(entry);
  if (version === 2) {
    return {
      tokenMessenger: entry.cctpTokenMessengerV2 ?? (pureV2 ? entry.cctpTokenMessenger : undefined),
      messageTransmitter: entry.cctpMessageTransmitterV2 ?? (pureV2 ? entry.cctpMessageTransmitter : undefined),
    };
  }
  // V1 is resolvable only on entries that actually had V1 (the drain path).
  if (pureV2) return { tokenMessenger: undefined, messageTransmitter: undefined };
  return { tokenMessenger: entry.cctpTokenMessenger, messageTransmitter: entry.cctpMessageTransmitter };
}

/**
 * CCTP domain for an entry. The registry documents "consumers default absent
 * to 0" — sane only for the chain's default source (historically Sepolia,
 * domain 0). For any other entry an absent domain is refused: defaulting a
 * catalog chain to Ethereum's domain would burn toward the wrong chain.
 */
export function cctpDomainFor(bridge: BridgeLike | undefined, entry: SourceEvmEntry): number | undefined {
  if (typeof entry.cctpDomain === "number") return entry.cctpDomain;
  const isDefaultSource = mergedCatalog(bridge)[0]?.chainId === entry.chainId;
  return isDefaultSource ? 0 : undefined;
}
