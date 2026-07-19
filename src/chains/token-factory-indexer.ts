/**
 * Background incremental factory indexer — the permissionless any-mint long-tail
 * of the token catalog. Rome caps eth_getLogs at 12k blocks and numbers blocks
 * by Solana slot (~474M), so a full-history factory scan can't run on the
 * request path. This indexer runs off-path:
 *   - resolves each chain's registration slot ONCE (binary search; "earliest"
 *     tag is unsupported) and caches it,
 *   - backfills registration→latest in ≤12k windows (halving on the 50k-result
 *     cap), then advances a cursor incrementally,
 *   - persists the accumulated mint-keyed set in Redis, which /v1/tokens reads
 *     via makeFactoryTokensFor (no getLogs on the request path).
 */
import type { ChainConfig } from "../registry/types.js";
import { liveContractAddress } from "../registry/contracts.js";
import { resolveRegistrationSlot, scanFactoryWindows, type FactoryLogSource, type BlockProbe } from "./token-factory-index.js";
import type { FactoryTokenInput } from "./token-catalog.js";
import type { RedisLike } from "./token-catalog-service.js";

/** A Rome chain source the indexer needs: getLogs (scan) + block probe (anchor). */
export type FactoryChainSource = FactoryLogSource & BlockProbe;

export interface FactoryIndexerDeps {
  redis: RedisLike;
  /** Live chains to index (registry-driven; each carries chainId + rpcUrl + factory). */
  listChains: () => Promise<ChainConfig[]>;
  /** Per-RPC chain source (default = a viem PublicClient adapter; tests inject a fake). */
  sourceFor: (rpcUrl: string) => FactoryChainSource;
  windowSize?: bigint | undefined;
  warn?: ((msg: string) => void) | undefined;
}

export interface FactoryIndexer {
  /** Index every chain once (per-chain errors are isolated + warned, never thrown). */
  runOnce(): Promise<void>;
  indexChainOnce(chain: ChainConfig): Promise<void>;
  /** The accumulated mint-keyed set for a chain ([] if the indexer hasn't run it). */
  getTokens(chainId: string): Promise<FactoryTokenInput[]>;
  /** Kick off an immediate run, then re-run every intervalMs (non-overlapping). */
  start(intervalMs: number): void;
  stop(): void;
}

const setKey = (id: string) => `tokencat:factory:${id}`;
const cursorKey = (id: string) => `tokencat:factory:${id}:cursor`;
const anchorKey = (id: string) => `tokencat:factory:${id}:anchor`;

/** Union by wrapper address (case-insensitive); first occurrence wins. */
function dedupeByWrapper(inputs: FactoryTokenInput[]): FactoryTokenInput[] {
  const seen = new Map<string, FactoryTokenInput>();
  for (const t of inputs) {
    const k = t.wrapper.toLowerCase();
    if (!seen.has(k)) seen.set(k, t);
  }
  return [...seen.values()];
}

export function makeFactoryIndexer(deps: FactoryIndexerDeps): FactoryIndexer {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function indexChainOnce(chain: ChainConfig): Promise<void> {
    const factory = liveContractAddress(chain, "ERC20SPLFactory");
    const rpc = chain.rpcUrl;
    if (!factory || !rpc) return; // registry-only chain — nothing to index
    const id = chain.chainId;
    const source = deps.sourceFor(rpc);
    const latest = await source.getBlockNumber();

    // Anchor = registration slot, resolved once (binary search) then cached forever.
    const anchorRaw = await deps.redis.get(anchorKey(id));
    let anchor: bigint;
    if (anchorRaw !== null) {
      anchor = BigInt(anchorRaw);
    } else {
      anchor = await resolveRegistrationSlot(source, latest);
      await deps.redis.set(anchorKey(id), anchor.toString());
    }

    const cursorRaw = await deps.redis.get(cursorKey(id));
    const from = cursorRaw !== null ? BigInt(cursorRaw) + 1n : anchor;
    if (from > latest) return; // caught up — nothing new since the last scan

    const fresh = await scanFactoryWindows(source, factory as `0x${string}`, from, latest, {
      ...(deps.windowSize !== undefined ? { windowSize: deps.windowSize } : {}),
      warn,
    });

    const existingRaw = await deps.redis.get(setKey(id));
    const existing = existingRaw ? (JSON.parse(existingRaw) as FactoryTokenInput[]) : [];
    await deps.redis.set(setKey(id), JSON.stringify(dedupeByWrapper([...existing, ...fresh])));
    await deps.redis.set(cursorKey(id), latest.toString());
  }

  async function runOnce(): Promise<void> {
    const chains = await deps.listChains();
    for (const chain of chains) {
      try {
        await indexChainOnce(chain);
      } catch (err) {
        warn(`[factory-indexer] chain ${chain.chainId} scan failed: ${(err as Error).message}`);
      }
    }
  }

  async function getTokens(chainId: string): Promise<FactoryTokenInput[]> {
    const raw = await deps.redis.get(setKey(chainId));
    return raw ? (JSON.parse(raw) as FactoryTokenInput[]) : [];
  }

  async function tick(): Promise<void> {
    if (running) return; // never overlap a still-running (possibly backfilling) tick
    running = true;
    try { await runOnce(); } finally { running = false; }
  }

  function start(intervalMs: number): void {
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
  }
  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { runOnce, indexChainOnce, getTokens, start, stop };
}
