/**
 * ChainInventory — composes on-chain truth (OwnerInfo) with off-chain enrichment (registry chain.json + bridge.json).
 *
 * Per the spec:
 *   - On-chain OwnerInfo PDA is authoritative for "is this chain registered + what's its gas mint."
 *   - Registry mirrors and enriches with human-readable metadata (name, RPC URL, source-EVM bridge addresses, assets).
 *   - Drift case (on-chain entry but no registry chain.json): return minimal view with on-chain data only.
 *
 * External-API posture:
 *   - Default scope = `registry.listExternalPrimaryPrograms()` (testnet + mainnet primaries only).
 *   - `{ programId }` override = a single specific program. Validated against
 *     `registry.listActivePrograms()` (any role / any network); throws
 *     `InvalidProgramIdError` if the program isn't in the registry.
 */

import { PublicKey } from "@solana/web3.js";
import { RegistryClient } from "../registry/client.js";
import { OwnerInfoClient, OwnerInfoEntry } from "./owner-info-reader.js";
import { ProgramListEntry } from "../registry/types.js";
import { chainCapabilities, ChainCapabilities } from "./capabilities.js";

export class InvalidProgramIdError extends Error {
  constructor(public programId: string) {
    super(`programId '${programId}' is not registered`);
    this.name = "InvalidProgramIdError";
  }
}

export interface ChainInventoryAsset {
  id?: string | undefined;
  symbol: string;
  solanaMint: string;
  decimals?: number | undefined;
}

export interface ChainInventoryDetail {
  chainId: string;
  programId: string;
  network: string;
  name: string | null;
  rpcUrl: string | null;
  gasMint: {
    solanaMint: string;
    symbol: string | null;
  };
  supportedAssets: ChainInventoryAsset[];
  singleState: boolean;
  /**
   * True iff this chain has a registry chain.json entry. False = drift (on-chain only).
   */
  hasRegistryEntry: boolean;
  /** Bridge rails + constraints for this chain (incl. spl: any-mint). */
  capabilities: ChainCapabilities;
}

export interface ChainInventoryOpts {
  registry: RegistryClient;
  ownerInfo: OwnerInfoClient;
}

export interface ScopeOpts {
  /**
   * When set, walks only the program with this base58 id. Validated against
   * `registry.listActivePrograms()`; throws `InvalidProgramIdError` if unknown.
   * When omitted, walks the external default scope (testnet + mainnet primaries).
   */
  programId?: string;
}

export class ChainInventory {
  constructor(private opts: ChainInventoryOpts) {}

  async listChains(scope?: ScopeOpts): Promise<ChainInventoryDetail[]> {
    const programs = await this.resolveScope(scope);
    const out: ChainInventoryDetail[] = [];
    for (const program of programs) {
      const entries = await this.opts.ownerInfo.listEntries(new PublicKey(program.id));
      for (const entry of entries) {
        out.push(await this.enrich(entry, program));
      }
    }
    return out;
  }

  /**
   * Find ALL chains matching `chainId` within the resolved scope. The default
   * scope (testnet + mainnet primaries) can return 0, 1, or 2 matches; with a
   * `{ programId }` override the result is always 0 or 1 (one program → one
   * OwnerInfo entry per chainId at most).
   */
  async getChainsByChainId(chainId: bigint, scope?: ScopeOpts): Promise<ChainInventoryDetail[]> {
    const programs = await this.resolveScope(scope);
    const matches: ChainInventoryDetail[] = [];
    for (const program of programs) {
      const entries = await this.opts.ownerInfo.listEntries(new PublicKey(program.id));
      const entry = entries.find((e) => e.chain === chainId);
      if (entry) matches.push(await this.enrich(entry, program));
    }
    return matches;
  }

  private async resolveScope(scope?: ScopeOpts): Promise<ProgramListEntry[]> {
    if (!scope?.programId) {
      return this.opts.registry.listExternalPrimaryPrograms();
    }
    const all = await this.opts.registry.listActivePrograms();
    const found = all.find((p) => p.id === scope.programId);
    if (!found) throw new InvalidProgramIdError(scope.programId);
    return [found];
  }

  private async enrich(entry: OwnerInfoEntry, program: ProgramListEntry): Promise<ChainInventoryDetail> {
    const chainIdStr = entry.chain.toString();
    const slug = program.chainsHosted.find((s) => s.startsWith(`${chainIdStr}-`));

    let chainJson: Awaited<ReturnType<RegistryClient["getChainJson"]>> = null;
    let bridgeJson: Awaited<ReturnType<RegistryClient["getBridgeJson"]>> = null;
    if (slug) {
      try { chainJson = await this.opts.registry.getChainJson(slug); } catch {}
      try { bridgeJson = await this.opts.registry.getBridgeJson(slug); } catch {}
    }

    const onchainMint = entry.mint?.toBase58() ?? "";
    let gasMintSymbol: string | null = null;
    if (bridgeJson?.assets) {
      const match = bridgeJson.assets.find((a) => a.solanaMint === onchainMint);
      if (match) gasMintSymbol = match.symbol;
    }
    if (!gasMintSymbol && chainJson?.nativeCurrency?.symbol) {
      gasMintSymbol = chainJson.nativeCurrency.symbol;
    }

    const supportedAssets: ChainInventoryAsset[] = (bridgeJson?.assets ?? []).map((a) => ({
      ...(a.id !== undefined ? { id: a.id } : {}),
      symbol: a.symbol,
      solanaMint: a.solanaMint,
      ...(a.decimals !== undefined ? { decimals: a.decimals } : {}),
    }));

    return {
      chainId: chainIdStr,
      programId: program.id,
      network: chainJson?.network ?? program.network,
      name: chainJson?.name ?? null,
      rpcUrl: chainJson?.rpcUrl ?? null,
      gasMint: { solanaMint: onchainMint, symbol: gasMintSymbol },
      supportedAssets,
      singleState: entry.singleState,
      hasRegistryEntry: chainJson !== null,
      capabilities: chainCapabilities(bridgeJson, { solanaMint: onchainMint, symbol: gasMintSymbol }),
    };
  }
}
