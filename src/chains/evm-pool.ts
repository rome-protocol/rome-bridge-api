import { createPublicClient, defineChain, http } from "viem";
import type { SourceEvmEntry } from "../registry/catalog.js";

/** Normalized on-chain tx view used by the equality-verification tuple. */
export interface EvmTxView {
  to: string;
  data: string;
  value: string;
}

interface ClientLike {
  getTransaction(args: { hash: `0x${string}` }): Promise<{ to?: string | null; input: string; value: bigint } | null>;
  call?(args: { account?: `0x${string}`; to: `0x${string}`; data: `0x${string}`; value?: bigint }): Promise<unknown>;
  getChainId?(): Promise<number>;
}

export interface SimulationResult {
  ok: boolean;
  revertReason?: string;
}

export type RpcOverrides = Record<string, string | string[]>;

export interface EvmClientPoolOpts {
  /** Parsed EVM_RPC_URLS_JSON — { "<chainId>": url | [urls] }. Takes precedence over the catalog rpcUrl. */
  rpcOverrides?: RpcOverrides | undefined;
  /** Test injection; production builds a viem client per source chain. */
  clientFactory?: ((chainId: number, rpcUrl: string, name: string) => ClientLike) | undefined;
}

/** `EVM_RPC_URLS_JSON={"11155111": ["https://…"], "10143": "https://…"}` */
export function parseRpcOverrides(json: string | undefined): RpcOverrides | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as RpcOverrides;
  } catch {
    throw new Error("EVM_RPC_URLS_JSON is not valid JSON");
  }
}

function defaultClientFactory(chainId: number, rpcUrl: string, name: string): ClientLike {
  const chain = defineChain({
    id: chainId,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

/**
 * One read-only EVM client per catalog source chain, keyed by chainId.
 * bridge-api is read-only on EVM chains (burn-tx verification, log parsing) —
 * no keys, so a new source chain costs exactly one RPC URL (catalog `rpcUrl`
 * or env override).
 */
export class EvmClientPool {
  private clients = new Map<number, ClientLike>();
  private factory: (chainId: number, rpcUrl: string, name: string) => ClientLike;

  constructor(private opts: EvmClientPoolOpts = {}) {
    this.factory = opts.clientFactory ?? defaultClientFactory;
  }

  rpcUrlFor(entry: SourceEvmEntry): string | undefined {
    const override = this.opts.rpcOverrides?.[String(entry.chainId)];
    const first = Array.isArray(override) ? override[0] : override;
    return first ?? entry.rpcUrl;
  }

  clientFor(entry: SourceEvmEntry): ClientLike {
    const cached = this.clients.get(entry.chainId);
    if (cached) return cached;
    const url = this.rpcUrlFor(entry);
    if (!url) throw new Error(`no RPC URL for source chain ${entry.chainId} (catalog rpcUrl or EVM_RPC_URLS_JSON)`);
    const client = this.factory(entry.chainId, url, entry.name ?? `evm-${entry.chainId}`);
    this.clients.set(entry.chainId, client);
    return client;
  }

  private pingCache = new Map<number, { ok: boolean; expiresAt: number }>();

  /** Cheap cached liveness probe (eth_chainId) for /health.sources — public-safe. */
  async pingChainId(entry: SourceEvmEntry, ttlMs = 60_000): Promise<{ ok: boolean }> {
    const cached = this.pingCache.get(entry.chainId);
    if (cached && cached.expiresAt > Date.now()) return { ok: cached.ok };
    let ok = false;
    try {
      const client = this.clientFor(entry);
      ok = client.getChainId ? (await client.getChainId()) === entry.chainId : true;
    } catch {
      ok = false;
    }
    this.pingCache.set(entry.chainId, { ok, expiresAt: Date.now() + ttlMs });
    return { ok };
  }

  /** Read-only preflight (eth_call) of an unsigned tx — catches approve/balance reverts before the wallet opens. */
  async simulateTx(
    entry: SourceEvmEntry,
    tx: { from: string; to: string; data: string; value?: string },
  ): Promise<SimulationResult> {
    const client = this.clientFor(entry);
    if (!client.call) return { ok: true }; // client can't simulate — never block the quote
    try {
      await client.call({
        account: tx.from as `0x${string}`,
        to: tx.to as `0x${string}`,
        data: tx.data as `0x${string}`,
        ...(tx.value && tx.value !== "0" ? { value: BigInt(tx.value) } : {}),
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason = /reverted with reason string '([^']+)'/.exec(msg)?.[1] ?? msg.split("\n")[0] ?? "reverted";
      return { ok: false, revertReason: reason };
    }
  }

  /** Fetching via the entry's own client IS the chainId binding of the verification tuple. */
  async readTx(entry: SourceEvmEntry, hash: string): Promise<EvmTxView | null> {
    try {
      const tx = await this.clientFor(entry).getTransaction({ hash: hash as `0x${string}` });
      if (!tx) return null;
      return {
        to: tx.to ?? "0x0000000000000000000000000000000000000000",
        data: tx.input,
        value: tx.value.toString(),
      };
    } catch {
      return null;
    }
  }
}
