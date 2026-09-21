/**
 * Registry contracts.json helpers. Contract addresses resolve from the
 * chain's published `versions[]` entry with `status: "live"` — never a
 * pinned constant; a registry redeploy PR is the only address rotation path.
 */
import type { ChainConfig } from "./types.js";

export interface ContractVersion {
  address?: string;
  version?: string;
  status?: string;
  [k: string]: unknown;
}

export interface ContractEntry {
  name?: string;
  versions?: ContractVersion[];
  [k: string]: unknown;
}

export function liveContractAddress(chain: Pick<ChainConfig, "contracts">, name: string): string | undefined {
  const entry = chain.contracts?.find((c) => c.name === name);
  return entry?.versions?.find((v) => v.status === "live")?.address;
}

export interface ContractLookup {
  /** contracts.json entry name, e.g. "RomeBridgeWithdraw". */
  name: string;
  /** Semver string the registry records for this address. */
  version?: string;
  /** live | deprecated | retired. Absent in the registry means live. */
  status: string;
  /** The address currently carrying status "live" for the same contract. */
  liveAddress?: string;
}

/**
 * Reverse lookup: which contract, and at what lifecycle status, is this
 * address?
 *
 * liveContractAddress() answers "what should I target now", which is right at
 * quote time. This answers "what did they actually target", which is the only
 * way to notice that a quote issued before a rotation is being settled after
 * it. Returns undefined for an address the registry does not list at all —
 * every inbound burn targets CCTP's TokenMessenger on a foreign chain, and
 * grading that as unknown-therefore-bad would reject the whole inbound lane.
 */
export function contractAtAddress(
  chain: Pick<ChainConfig, "contracts">,
  address: string,
): ContractLookup | undefined {
  const want = address.toLowerCase();
  for (const entry of chain.contracts ?? []) {
    const hit = entry.versions?.find((v) => v.address?.toLowerCase() === want);
    if (!hit) continue;
    const live = entry.versions?.find((v) => v.status === "live")?.address;
    const out: ContractLookup = {
      name: entry.name ?? "<unnamed>",
      // Absent status means live, matching the registry's own convention.
      status: hit.status ?? "live",
    };
    if (hit.version !== undefined) out.version = hit.version;
    if (live !== undefined) out.liveAddress = live;
    return out;
  }
  return undefined;
}
