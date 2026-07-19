/**
 * Mint-keyed bridge token catalog.
 *
 * The SPL mint is the asset identity; wrappers are fungible views over a mint
 * (a mint can have 0/1/N wrappers — same truth as v10's mint-keyed allowlist).
 * The catalog merges two tiers, per Rome's VERIFICATION_RULES:
 *   - registry tokens.json  → verified (curated)
 *   - on-chain ERC20SPL factory `TokenCreated` → unverified (permissionless long-tail)
 * A mint present in both is verified; its wrappers are unioned (registry-canonical
 * first), and its symbol/decimals come from the registry (the authoritative source).
 */

export interface RegistryTokenInput {
  mint: string;
  wrapper?: string;
  symbol?: string;
  decimals?: number;
}

export interface FactoryTokenInput {
  mint: string;
  wrapper: string;
  symbol?: string;
  decimals?: number;
}

export interface TokenCatalogEntry {
  mint: string;
  symbol?: string;
  decimals?: number;
  /** true iff the mint appears in the registry (curated); factory-only = false. */
  verified: boolean;
  /** Known wrapper addresses for this mint, registry-canonical first, case-insensitively deduped. */
  wrappers: string[];
}

/** Subset of a registry tokens.json entry the catalog needs. Optionals carry
 *  `| undefined` so the registry's zod `TokenEntryT` (passthrough) is assignable. */
export interface RegistryTokenEntry {
  kind: string;
  mintId?: string | undefined;
  address?: string | undefined;
  symbol?: string | undefined;
  decimals?: number | undefined;
}

// Kinds that represent a real ERC20-SPL wrapper over a mint. `gas` is excluded:
// its `address` is a sentinel (0xeee…) and its decimals are gas-decimals (18),
// not the SPL's — the gas mint is surfaced via chain capabilities, and if it also
// has a real wrapper (e.g. USDC→wUSDC) that spl_wrapper entry carries it correctly.
const WRAPPER_KINDS = new Set(["spl_wrapper", "erc20"]);

/** Project registry tokens.json entries to mint-keyed catalog inputs (wrappers only). */
export function registryTokensToInputs(tokens: RegistryTokenEntry[]): RegistryTokenInput[] {
  const out: RegistryTokenInput[] = [];
  for (const t of tokens) {
    if (!WRAPPER_KINDS.has(t.kind)) continue; // gas/native and unknown kinds carry no wrapper
    if (!t.mintId) continue; // mint is the key; no mint ⇒ can't catalog it
    const input: RegistryTokenInput = { mint: t.mintId };
    if (t.address !== undefined) input.wrapper = t.address;
    if (t.symbol !== undefined) input.symbol = t.symbol;
    if (t.decimals !== undefined) input.decimals = t.decimals;
    out.push(input);
  }
  return out;
}

/**
 * End-to-end route helper: tokens.json entries + factory tokens → the sorted,
 * mint-keyed catalog list the /v1/tokens response returns. Verified (curated)
 * entries first, then by symbol, then mint — a stable, client-friendly order.
 */
export function buildTokenList(
  registryEntries: RegistryTokenEntry[],
  factoryTokens: FactoryTokenInput[],
): TokenCatalogEntry[] {
  const map = buildTokenCatalog(registryTokensToInputs(registryEntries), factoryTokens);
  return [...map.values()].sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1; // curated first
    const as = a.symbol ?? "";
    const bs = b.symbol ?? "";
    if (as !== bs) return as < bs ? -1 : 1;
    return a.mint < b.mint ? -1 : 1;
  });
}

/**
 * Resolve the canonical (registry-preferred) ERC20-SPL wrapper for a mint from
 * the chain's tokens.json. Lets mint-first callers (e.g. Wormhole egress) supply
 * only the mint; the bridge resolves the wrapper. Returns undefined if unknown.
 */
export function resolveCanonicalWrapper(registryTokens: RegistryTokenEntry[], mint: string): string | undefined {
  return buildTokenCatalog(registryTokensToInputs(registryTokens), []).get(mint)?.wrappers[0];
}

export function buildTokenCatalog(
  registry: RegistryTokenInput[],
  factory: FactoryTokenInput[],
): Map<string, TokenCatalogEntry> {
  const cat = new Map<string, TokenCatalogEntry>();
  const seenWrapper = new Map<string, Set<string>>(); // mint -> lowercased wrapper addresses

  const ensure = (mint: string): TokenCatalogEntry => {
    let e = cat.get(mint);
    if (!e) {
      e = { mint, verified: false, wrappers: [] };
      cat.set(mint, e);
      seenWrapper.set(mint, new Set());
    }
    return e;
  };

  const addWrapper = (mint: string, wrapper: string | undefined): void => {
    if (!wrapper) return;
    const seen = seenWrapper.get(mint)!;
    const key = wrapper.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    cat.get(mint)!.wrappers.push(wrapper);
  };

  // Registry first: verified, canonical wrapper listed first, authoritative symbol/decimals.
  for (const r of registry) {
    const e = ensure(r.mint);
    e.verified = true;
    if (r.symbol !== undefined) e.symbol = r.symbol;
    if (r.decimals !== undefined) e.decimals = r.decimals;
    addWrapper(r.mint, r.wrapper);
  }

  // Factory next: append wrappers (deduped); fill symbol/decimals only where the registry was silent.
  for (const f of factory) {
    const e = ensure(f.mint);
    if (e.symbol === undefined && f.symbol !== undefined) e.symbol = f.symbol;
    if (e.decimals === undefined && f.decimals !== undefined) e.decimals = f.decimals;
    addWrapper(f.mint, f.wrapper);
  }

  return cat;
}
