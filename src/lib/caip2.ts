/**
 * CAIP-2 chain identity.
 *
 * One identifier scheme spans EVM + Solana: `eip155:<id>` embeds the EIP-155
 * chain id verbatim; `solana:<genesis-hash-prefix>` uses the first 32 chars of
 * the cluster's genesis blockhash (CAIP-30 convention — well-known public
 * constants, same class as program ids). Requests dual-accept the legacy
 * symbolic rails during the Sunset window; responses emit CAIP-2 alongside.
 */

export const SOLANA_GENESIS_PREFIX: Record<string, string> = {
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
};

export function caip2ForEvm(chainId: number | string): string {
  return `eip155:${chainId}`;
}

export function caip2ForSolanaCluster(cluster: string): string | undefined {
  const prefix = SOLANA_GENESIS_PREFIX[cluster];
  return prefix ? `solana:${prefix}` : undefined;
}

export interface StepChainContext {
  /** The chain's default source EVM chain id (catalog entry 0). */
  defaultEvmChainId: number;
  /** The Rome chain's Solana substrate cluster (chain.json solana.cluster). */
  solanaCluster: string;
}

/** Translate a legacy step `chain` label ("ethereum" | "evm-<id>" | "solana" | "rome-<id>") to CAIP-2. */
export function chainRefForStep(chainLabel: string, ctx: StepChainContext): string | undefined {
  if (chainLabel === "ethereum") return caip2ForEvm(ctx.defaultEvmChainId);
  const evm = /^evm-(\d+)$/.exec(chainLabel);
  if (evm) return caip2ForEvm(Number(evm[1]));
  const rome = /^rome-(\d+)$/.exec(chainLabel);
  if (rome) return caip2ForEvm(Number(rome[1]));
  if (chainLabel === "solana") return caip2ForSolanaCluster(ctx.solanaCluster);
  return undefined;
}

export type Rail = "ethereum" | "solana" | "rome";

export interface ParsedSourceChain {
  rail: Rail;
  sourceChainId?: number;
  /** True when the request used a legacy symbolic rail — drives the Sunset header. */
  symbolicUsed: boolean;
}

/**
 * Dual-accept the quote request's `sourceChain`: legacy symbolic rail OR a
 * CAIP-2 identifier. A CAIP-2 eip155 source implies the ethereum rail and a
 * sourceChainId; if the caller ALSO sent sourceChainId they must agree.
 */
export function parseSourceChainInput(input: { sourceChain: string; sourceChainId?: number | undefined }): ParsedSourceChain {
  const { sourceChain, sourceChainId } = input;

  if (sourceChain === "ethereum" || sourceChain === "solana" || sourceChain === "rome") {
    const out: ParsedSourceChain = { rail: sourceChain, symbolicUsed: true };
    if (sourceChainId !== undefined) out.sourceChainId = sourceChainId;
    return out;
  }

  const eip155 = /^eip155:(\d+)$/.exec(sourceChain);
  if (eip155) {
    const implied = Number(eip155[1]);
    if (sourceChainId !== undefined && sourceChainId !== implied) {
      throw new Error(`source chain conflict: sourceChain ${sourceChain} vs sourceChainId ${sourceChainId}`);
    }
    return { rail: "ethereum", sourceChainId: implied, symbolicUsed: false };
  }

  if (/^solana:[1-9A-HJ-NP-Za-km-z]+$/.test(sourceChain)) {
    return { rail: "solana", symbolicUsed: false };
  }

  throw new Error(`unsupported sourceChain namespace: ${sourceChain}`);
}
