/**
 * Resolve a Rome chain's GAS MINT from the on-chain rome-evm program (OwnerInfo
 * PDA), the authoritative source of the per-chain gas designation.
 *
 * Why on-chain, not `chain.gasToken.mintId` from the registry: the registry is a
 * mirror and can drift; the rome-evm program's OwnerInfo is the truth the settle
 * path itself enforces. Reading it here keeps every gas-vs-wrapper decision
 * (outbound routing, inbound claim-as-gas, settle authorization) agnostic and
 * consistent with what the program will accept.
 *
 * Cached per (programId, chainId) with a short TTL — OwnerInfo rarely changes and
 * a Solana round-trip per /quote would add latency to the hot path. Never throws:
 * RPC failure / missing PDA / unregistered chain all resolve to null so callers
 * can fall back (registry mirror) rather than 500 the quote.
 */
import { PublicKey, type Commitment } from "@solana/web3.js";
import { OwnerInfoClient } from "./owner-info-reader.js";

const TTL_MS = 60_000;

export interface GasMintResolver {
  /** On-chain gas mint (base58) for the chain, or null if unresolved. */
  resolve(programId: string, chainId: string | number): Promise<string | null>;
}

interface RpcConnectionLike {
  getAccountInfo(pubkey: PublicKey, opts?: { commitment?: Commitment }): Promise<{ data: Buffer } | null>;
}

export function makeGasMintResolver(connection: RpcConnectionLike): GasMintResolver {
  const client = new OwnerInfoClient({ connection });
  const cache = new Map<string, { mint: string | null; at: number }>();
  return {
    async resolve(programId, chainId) {
      const key = `${programId}:${chainId}`;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < TTL_MS) return hit.mint;
      let mint: string | null = null;
      try {
        const pk = await client.getMintForChain(new PublicKey(programId), BigInt(chainId));
        mint = pk ? pk.toBase58() : null;
      } catch {
        mint = null; // never throw on the quote hot path
      }
      cache.set(key, { mint, at: now });
      return mint;
    },
  };
}
