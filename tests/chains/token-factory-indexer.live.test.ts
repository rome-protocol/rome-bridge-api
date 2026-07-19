import { describe, it, expect } from "vitest";
import { createPublicClient, http } from "viem";
import { resolveRegistrationSlot, scanFactoryWindows } from "../../src/chains/token-factory-index";

/**
 * Opt-in LIVE integration test — exercises the real viem chain source (getLogs +
 * getBlockNumber + getBlock/blockExists) against a real Rome chain, read-only, no
 * funds. Proves the indexer's anchor resolution + paginated scan work against
 * Rome's actual eth_getLogs cap + Solana-slot block numbering (what the unit
 * tests fake). Skipped by default (network-dependent + slow).
 *
 *   BRIDGE_API_LIVE_FACTORY=1 [FACTORY_RPC=…] [FACTORY_ADDR=…] \
 *     npx vitest run tests/chains/token-factory-indexer.live.test.ts
 */
const RUN = process.env.BRIDGE_API_LIVE_FACTORY === "1";
const RPC = process.env.FACTORY_RPC ?? "https://hadrian.testnet.romeprotocol.xyz/";
const FACTORY = (process.env.FACTORY_ADDR ?? "0x86149124d74ebb3aa41a19641b700e88202b6285") as `0x${string}`;

(RUN ? describe : describe.skip)("factory indexer — live Rome scan (opt-in)", () => {
  it("resolves the registration anchor and enumerates all factory wrappers", { timeout: 180_000 }, async () => {
    const client = createPublicClient({ transport: http(RPC) });
    const source = {
      getLogs: (args: Parameters<typeof client.getLogs>[0]) => client.getLogs(args),
      getBlockNumber: () => client.getBlockNumber(),
      blockExists: async (n: bigint) => {
        try { await client.getBlock({ blockNumber: n }); return true; } catch { return false; }
      },
    } as never;

    const latest = await (source as { getBlockNumber: () => Promise<bigint> }).getBlockNumber();
    const anchor = await resolveRegistrationSlot(source, latest);
    expect(anchor).toBeGreaterThan(0n);
    expect(anchor).toBeLessThanOrEqual(latest);

    const tokens = await scanFactoryWindows(source, FACTORY, anchor, latest, { windowSize: 10_000n });
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58 Solana mint
      expect(t.wrapper).toMatch(/^0x[0-9a-fA-F]{40}$/);        // 0x EVM wrapper
    }
    const wrappers = new Set(tokens.map((t) => t.wrapper.toLowerCase()));
    expect(wrappers.size).toBe(tokens.length); // wrappers are unique
    // eslint-disable-next-line no-console
    console.log(`live factory scan: ${tokens.length} wrappers, anchor=${anchor}, latest=${latest}`);
  });
});
