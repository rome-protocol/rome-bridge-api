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
