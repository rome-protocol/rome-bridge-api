import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { RegistryClient } from "../../src/registry/client";
import type { ChainConfig } from "../../src/registry/types";

/** Generated-from-published fixtures (scripts/gen-registry-fixtures.ts). */
export const FIXTURES_DIR = join(__dirname, "..", "fixtures", "registry");

let cache: Promise<ChainConfig[]> | null = null;
export function loadFixtureChains(): Promise<ChainConfig[]> {
  cache ??= new RegistryClient({ source: { kind: "local", path: FIXTURES_DIR } }).listChains();
  return cache;
}

export async function loadFixtureChain(chainId: string): Promise<ChainConfig> {
  const chain = (await loadFixtureChains()).find((c) => c.chainId === chainId);
  if (!chain) throw new Error(`fixture chain ${chainId} not found — run \`npm run gen:fixtures\``);
  return chain;
}

/**
 * Write a PUBLISHED-SHAPE chain triad (chain.json + bridge.json + tokens.json)
 * into a temp registry dir. For synthetic cases the live registry doesn't
 * publish (wSOL-gas chains, missing-field refusals). The shape mirrors the
 * registry's schemas exactly — phantom shapes are banned in tests.
 */
export function writePublishedChain(
  dir: string,
  slug: string,
  files: { chain: object; bridge?: object; tokens?: object[] },
): void {
  const chainDir = join(dir, "chains", slug);
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(join(chainDir, "chain.json"), JSON.stringify(files.chain, null, 2));
  if (files.bridge) writeFileSync(join(chainDir, "bridge.json"), JSON.stringify(files.bridge, null, 2));
  if (files.tokens) writeFileSync(join(chainDir, "tokens.json"), JSON.stringify(files.tokens, null, 2));
}

export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const WSOL_MINT_B58 = "So11111111111111111111111111111111111111112";

/** Canonical test RomeBridgeWithdraw address (mirrors Hadrian's live v6). */
export const ROME_BRIDGE_WITHDRAW = "0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b";

/** Published-shape synthetic merged config for builder unit tests. */
export function syntheticChain(opts: {
  chainId?: string;
  gasMintId?: string;
  gasSymbol?: string;
  bridge?: ChainConfig["bridge"];
  tokens?: ChainConfig["tokens"];
  romeEvmProgramId?: string;
  /** RomeBridgeWithdraw egress contract. Defaults to the canonical test addr;
   *  pass null to OMIT it (exercises the "no live RomeBridgeWithdraw" refusal). */
  withdrawAddress?: string | null;
}): ChainConfig {
  const gasMintId = opts.gasMintId ?? USDC_DEVNET_MINT;
  const withdraw = opts.withdrawAddress === undefined ? ROME_BRIDGE_WITHDRAW : opts.withdrawAddress;
  return {
    chainId: opts.chainId ?? "121301",
    slug: `${opts.chainId ?? "121301"}-synthetic`,
    name: "Synthetic",
    network: "devnet",
    status: "live",
    romeEvmProgramId: opts.romeEvmProgramId ?? "romedpkFKEu3JJrYujtNUferyEv47UxvjZe2QcdPwN8",
    bridge: opts.bridge ?? { sourceEvm: { chainId: 11155111 }, solana: { cctpDomain: 5 } },
    tokens: opts.tokens ?? [],
    gasToken: { kind: "gas", mintId: gasMintId, gasPool: "AkZ6NSKzoM6Q3TqVwgtCixpjBDRqEhs5YTZxYzX6s2Jt", symbol: opts.gasSymbol ?? "USDC" },
    ...(withdraw ? { contracts: [{ name: "RomeBridgeWithdraw", versions: [{ version: "6.0.0", status: "live", address: withdraw }] }] } : {}),
  };
}
