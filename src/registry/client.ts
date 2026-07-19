import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChainConfig, PublishedChainJson, BridgeConfigSchema, TokenEntrySchema, ContractEntrySchema, ProgramsIndex, ProgramsIndexT, ProgramListEntry, ProgramRoleT, ChainJsonLoose, ChainJsonLooseT, BridgeJsonLoose, BridgeJsonLooseT } from "./types.js";
import { z } from "zod";
import { withTimeout } from "../lib/fetch-timeout.js";
import { resolvePrimaryNetworks } from "../config.js";

export interface RegistrySource {
  kind: "local" | "github";
  path?: string;
  ref?: string;
  authToken?: string;
}

export interface RegistryClientOpts {
  source: RegistrySource;
  /** Injectable fetch for tests; production uses global fetch. */
  fetch?: typeof fetch;
  /** Injectable sink for per-chain skip warnings; defaults to console.warn. */
  warn?: (msg: string) => void;
  /** Rome networks whose primary program the default scope walks. Defaults to
   *  resolvePrimaryNetworks() (env PRIMARY_NETWORKS, else testnet+mainnet). */
  primaryNetworks?: string[];
}

const GH_REPO  = "rome-protocol/rome-registry";
const RAW_BASE = "https://raw.githubusercontent.com";
const API_BASE = "https://api.github.com";

const TokensJsonSchema = z.array(TokenEntrySchema);
const ContractsJsonSchema = z.array(ContractEntrySchema);

export class RegistryClient {
  private fetchFn: typeof fetch;
  private warn: (msg: string) => void;

  constructor(private opts: RegistryClientOpts) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch.bind(globalThis), 15_000);
    this.warn = opts.warn ?? ((msg) => console.warn(msg));
  }

  // ── Public surface ───────────────────────────────────────────────────

  async listChains(): Promise<ChainConfig[]> {
    if (this.opts.source.kind === "local")  return this.listChainsLocal(this.opts.source.path!);
    if (this.opts.source.kind === "github") return this.listChainsGithub();
    throw new Error(`unknown registry source kind: ${(this.opts.source as { kind: string }).kind}`);
  }

  async getProgramsIndex(): Promise<ProgramsIndexT> {
    const raw = this.opts.source.kind === "local"
      ? await this.readLocalText(join(this.opts.source.path!, "programs", "index.json"))
      : await this.readGithubText("programs/index.json");
    if (raw === null) throw new Error("programs/index.json not found");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("programs/index.json malformed JSON"); }
    const result = ProgramsIndex.safeParse(parsed);
    if (!result.success) throw new Error(`programs/index.json schema invalid: ${result.error.message}`);
    return result.data;
  }

  async listExternalPrimaryPrograms(): Promise<ProgramListEntry[]> {
    const idx = await this.getProgramsIndex();
    const networks = this.opts.primaryNetworks ?? resolvePrimaryNetworks();
    const out: ProgramListEntry[] = [];
    for (const network of networks) {
      const id = (idx.primary as Record<string, string | undefined>)[network];
      if (!id) continue;
      const meta = idx.programs[id];
      if (meta) out.push({ id, ...meta });
    }
    return out;
  }

  async listActivePrograms(opts?: { networks?: string[] }): Promise<ProgramListEntry[]> {
    const idx = await this.getProgramsIndex();
    const active: ProgramRoleT[] = ["primary", "secondary"];
    const out: ProgramListEntry[] = [];
    for (const [id, entry] of Object.entries(idx.programs)) {
      if (!active.includes(entry.role)) continue;
      if (opts?.networks && !opts.networks.includes(entry.network)) continue;
      out.push({ id, ...entry });
    }
    return out;
  }

  async getChainJson(slug: string): Promise<ChainJsonLooseT | null> {
    const raw = this.opts.source.kind === "local"
      ? await this.readLocalText(join(this.opts.source.path!, "chains", slug, "chain.json"))
      : await this.readGithubText(`chains/${slug}/chain.json`);
    if (raw === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`chain.json malformed at ${slug}`); }
    const result = ChainJsonLoose.safeParse(parsed);
    if (!result.success) throw new Error(`chain.json schema invalid at ${slug}: ${result.error.message}`);
    return result.data;
  }

  async getBridgeJson(slug: string): Promise<BridgeJsonLooseT | null> {
    const raw = this.opts.source.kind === "local"
      ? await this.readLocalText(join(this.opts.source.path!, "chains", slug, "bridge.json"))
      : await this.readGithubText(`chains/${slug}/bridge.json`);
    if (raw === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`bridge.json malformed at ${slug}`); }
    const result = BridgeJsonLoose.safeParse(parsed);
    if (!result.success) throw new Error(`bridge.json schema invalid at ${slug}: ${result.error.message}`);
    return result.data;
  }

  // ── Local-source helpers ─────────────────────────────────────────────

  private async readLocalText(path: string): Promise<string | null> {
    try { return await readFile(path, "utf8"); } catch { return null; }
  }

  private async listChainsLocal(root: string): Promise<ChainConfig[]> {
    const chainsDir = join(root, "chains");
    const entries = await readdir(chainsDir, { withFileTypes: true });
    const chains: ChainConfig[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const chain = await this.loadChain(entry.name, (rel) => this.readLocalText(join(root, rel)));
      if (chain) chains.push(chain);
    }
    return chains;
  }

  /**
   * Merge the three published per-chain files into one ChainConfig.
   * Fail-closed PER CHAIN: a chain whose files don't parse is skipped with a
   * warning — one bad or future-shaped chain must never take the whole
   * endpoint down. Non-live chains (including unknown status values) return
   * null silently.
   */
  private async loadChain(slug: string, read: (rel: string) => Promise<string | null>): Promise<ChainConfig | null> {
    const chainRaw = await read(`chains/${slug}/chain.json`);
    if (chainRaw === null) return null;
    let chainParsed: unknown;
    try { chainParsed = JSON.parse(chainRaw); }
    catch { this.warn(`registry: skipping ${slug} — malformed chain.json`); return null; }
    const chain = PublishedChainJson.safeParse(chainParsed);
    if (!chain.success) { this.warn(`registry: skipping ${slug} — chain.json shape: ${chain.error.issues[0]?.message}`); return null; }
    if (chain.data.status !== "live") return null;

    const config: ChainConfig = { ...chain.data, slug };

    const bridgeRaw = await read(`chains/${slug}/bridge.json`);
    if (bridgeRaw !== null) {
      let bridgeParsed: unknown;
      try { bridgeParsed = JSON.parse(bridgeRaw); }
      catch { this.warn(`registry: skipping ${slug} — malformed bridge.json`); return null; }
      const bridge = BridgeConfigSchema.safeParse(bridgeParsed);
      if (!bridge.success) { this.warn(`registry: skipping ${slug} — bridge.json shape: ${bridge.error.issues[0]?.message}`); return null; }
      config.bridge = bridge.data;
    }

    const contractsRaw = await read(`chains/${slug}/contracts.json`);
    if (contractsRaw !== null) {
      let contractsParsed: unknown;
      try { contractsParsed = JSON.parse(contractsRaw); }
      catch { this.warn(`registry: skipping ${slug} — malformed contracts.json`); return null; }
      const contracts = ContractsJsonSchema.safeParse(contractsParsed);
      if (!contracts.success) { this.warn(`registry: skipping ${slug} — contracts.json shape: ${contracts.error.issues[0]?.message}`); return null; }
      config.contracts = contracts.data;
    }

    const tokensRaw = await read(`chains/${slug}/tokens.json`);
    if (tokensRaw !== null) {
      let tokensParsed: unknown;
      try { tokensParsed = JSON.parse(tokensRaw); }
      catch { this.warn(`registry: skipping ${slug} — malformed tokens.json`); return null; }
      const tokens = TokensJsonSchema.safeParse(tokensParsed);
      if (!tokens.success) { this.warn(`registry: skipping ${slug} — tokens.json shape: ${tokens.error.issues[0]?.message}`); return null; }
      config.tokens = tokens.data;
      config.gasToken = tokens.data.find((t) => t.kind === "gas");
    }

    return config;
  }

  // ── GitHub-source helpers ────────────────────────────────────────────

  /** Fetch a single file from raw.githubusercontent.com. Returns null on 404. */
  private async readGithubText(path: string): Promise<string | null> {
    const ref = this.opts.source.ref ?? "main";
    const url = `${RAW_BASE}/${GH_REPO}/${ref}/${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.source.authToken) headers.Authorization = `Bearer ${this.opts.source.authToken}`;
    const res = await this.fetchFn(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`registry fetch ${url} failed: HTTP ${res.status}`);
    return res.text();
  }

  /** List directory entries at /chains via the GitHub Contents API. */
  private async listGithubChainSlugs(): Promise<string[]> {
    const ref = this.opts.source.ref ?? "main";
    const url = `${API_BASE}/repos/${GH_REPO}/contents/chains?ref=${ref}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.source.authToken) headers.Authorization = `Bearer ${this.opts.source.authToken}`;
    const res = await this.fetchFn(url, { headers });
    if (!res.ok) throw new Error(`registry list ${url} failed: HTTP ${res.status}`);
    const body = (await res.json()) as ReadonlyArray<{ name: string; type: string }>;
    return body.filter((e) => e.type === "dir").map((e) => e.name);
  }

  private async listChainsGithub(): Promise<ChainConfig[]> {
    const slugs = await this.listGithubChainSlugs();
    const out: ChainConfig[] = [];
    for (const slug of slugs) {
      const chain = await this.loadChain(slug, (rel) => this.readGithubText(rel));
      if (chain) out.push(chain);
    }
    return out;
  }
}
