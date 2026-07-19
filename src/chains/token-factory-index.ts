/**
 * On-chain ERC20SPL factory index — the permissionless long-tail of the token
 * catalog. Reads `TokenCreated` events (every wrapper anyone ever minted, incl.
 * user LSTs) and projects them to mint-keyed catalog inputs. The event's mint is
 * a Solana pubkey as bytes32; the catalog keys on base58 (matching registry
 * tokens.json), so we convert here.
 */
import { PublicKey } from "@solana/web3.js";
import { parseAbiItem } from "viem";
import type { FactoryTokenInput } from "./token-catalog.js";

export const TOKEN_CREATED_EVENT = parseAbiItem(
  "event TokenCreated(address indexed creator, bytes32 indexed mint, address indexed wrapper, string name, string symbol, uint64 nonce)",
);

/** Solana pubkey bytes32 (0x-hex) → base58. */
export function mintBytes32ToBase58(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new PublicKey(Buffer.from(clean, "hex")).toBase58();
}

export interface DecodedTokenCreated {
  mint: string; // bytes32 hex
  wrapper: string; // 0x address
  symbol?: string;
}

export function factoryEventToInput(e: DecodedTokenCreated): FactoryTokenInput {
  const out: FactoryTokenInput = { mint: mintBytes32ToBase58(e.mint), wrapper: e.wrapper };
  if (e.symbol) out.symbol = e.symbol; // drop empty/undefined symbols
  return out;
}

/** Minimal shape of a viem PublicClient's getLogs — injectable for tests. */
export interface FactoryLogSource {
  getLogs(args: {
    address: `0x${string}`;
    event: typeof TOKEN_CREATED_EVENT;
    fromBlock?: bigint;
    toBlock?: bigint | "latest";
  }): Promise<Array<{ args: { mint?: string; wrapper?: string; symbol?: string; name?: string } }>>;
}

type FactoryLog = { args: { mint?: string; wrapper?: string; symbol?: string; name?: string } };

/** Map raw TokenCreated logs → mint-keyed inputs (base58 mints; empty symbols dropped). */
export function logsToInputs(logs: FactoryLog[]): FactoryTokenInput[] {
  return logs
    .filter((l) => l.args?.mint && l.args?.wrapper)
    .map((l) => {
      const d: DecodedTokenCreated = { mint: l.args.mint as string, wrapper: l.args.wrapper as string };
      if (l.args.symbol !== undefined) d.symbol = l.args.symbol;
      return factoryEventToInput(d);
    });
}

/** All wrappers ever created on the factory, as mint-keyed inputs (base58 mints).
 *  Single-window getLogs(0→latest) — only safe where the chain won't hit Rome's
 *  eth_getLogs block cap; the indexer uses scanFactoryWindows for real chains. */
export async function fetchFactoryTokens(
  client: FactoryLogSource,
  factory: `0x${string}`,
  fromBlock: bigint = 0n,
): Promise<FactoryTokenInput[]> {
  return logsToInputs(await client.getLogs({ address: factory, event: TOKEN_CREATED_EVENT, fromBlock, toBlock: "latest" }));
}

/** Block-presence probe for anchor resolution (a viem PublicClient satisfies it). */
export interface BlockProbe {
  getBlockNumber(): Promise<bigint>;
  blockExists(blockNumber: bigint): Promise<boolean>;
}

/**
 * Binary-search the chain's registration slot = the lowest block that exists.
 * Rome numbers blocks by Solana slot (~474M) and rejects the "earliest" tag, so
 * we bisect [0, latest]: the whole region below registration is absent, so we
 * converge on the boundary in ~log2(latest) ≈ 29 probes. This is a safe lower
 * bound for a factory scan — no TokenCreated can predate the chain's existence.
 */
export async function resolveRegistrationSlot(probe: BlockProbe, latestArg?: bigint): Promise<bigint> {
  const latest = latestArg ?? (await probe.getBlockNumber());
  // NB: do NOT early-return on blockExists(0). Rome exposes a synthetic genesis
  // at block 0 while blocks 1..registration are absent (the chain didn't exist at
  // those Solana slots). Bisecting [0, latest] converges on the contiguous chain
  // region's first block (= registration): the first midprobe ≈ latest/2 lands in
  // the null gap and moves `lo` up, so block 0 is never mistaken for the answer.
  let lo = 0n;     // moves up to a known-absent block on the first gap probe
  let hi = latest; // the tip — always present
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await probe.blockExists(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

export interface WindowScanOpts { windowSize?: bigint | undefined; warn?: ((msg: string) => void) | undefined; }

const DEFAULT_WINDOW = 10_000n; // headroom under Rome's 12k eth_getLogs block cap

function isRangeOrLimitError(err: unknown): boolean {
  return /more than|too wide|-32005|block range/i.test((err as Error)?.message ?? "");
}

async function getLogsAdaptive(
  source: FactoryLogSource, factory: `0x${string}`, from: bigint, to: bigint,
): Promise<FactoryTokenInput[]> {
  try {
    return logsToInputs(await source.getLogs({ address: factory, event: TOKEN_CREATED_EVENT, fromBlock: from, toBlock: to }));
  } catch (err) {
    // Rome also caps a single query at 50k results; halve the window and retry.
    // A single block that still errors rethrows — terminates the recursion.
    if (from < to && isRangeOrLimitError(err)) {
      const mid = (from + to) / 2n;
      return [
        ...(await getLogsAdaptive(source, factory, from, mid)),
        ...(await getLogsAdaptive(source, factory, mid + 1n, to)),
      ];
    }
    throw err;
  }
}

/**
 * Paginate [fromBlock, toBlock] (inclusive) in windows ≤ windowSize, calling
 * getLogs per window, halving on Rome's results-limit error. Returns mint-keyed
 * inputs across all windows.
 */
export async function scanFactoryWindows(
  source: FactoryLogSource,
  factory: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  opts: WindowScanOpts = {},
): Promise<FactoryTokenInput[]> {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
  const out: FactoryTokenInput[] = [];
  for (let from = fromBlock; from <= toBlock; from += windowSize) {
    const end = from + windowSize - 1n;
    const to = end < toBlock ? end : toBlock;
    out.push(...(await getLogsAdaptive(source, factory, from, to)));
  }
  return out;
}
