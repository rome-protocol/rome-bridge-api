/**
 * Poller: from-rome Wormhole claim materialization (registration parity —
 * spec Phase-2 pre-B2 dependency).
 *
 * A registered eth/token-wormhole-from-rome record holds a claim step
 * (blocked, [step-1, wormhole-vaa]) with builder-stamped claimTokenBridge +
 * claimMethod and registration-stamped romeRpcUrl. The poller: resolves the
 * burn's Solana sig (rome RPC), asks wormholescan by txHash, and when the VAA
 * is signed — confirms step 1 (VAA existence proves the burn mined) and flips
 * the claim ready with the redeem calldata (completeTransfer* on the
 * destination token bridge, arg = the VAA bytes).
 */
import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { decodeFunctionData, parseAbi } from "viem";
import { AttestationPoller } from "../../src/attestation/poller";
import { TransferStore } from "../../src/transfers/store";

const TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const CLAIM_ABI = parseAbi([
  "function completeTransferAndUnwrapETH(bytes encodedVm)",
  "function completeTransfer(bytes encodedVm)",
]);
// base64 "hello-vaa" — content is opaque to the poller.
const VAA_B64 = Buffer.from("hello-vaa").toString("base64");

let n = 0;
async function makeWhOutRecord(over: Record<string, unknown> = {}) {
  const redis = new RedisMock() as unknown as import("ioredis").Redis;
  const store = new TransferStore(redis);
  const romeTx = `0xwhburn${++n}`;
  const id = await store.create({
    route: "eth-wormhole-from-rome", direction: "from-rome", amountIn: "1", amountOut: "1",
    sender: { rome: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    steps: [
      { n: 1, chain: "rome-200010", kind: "wormhole-burn-eth", status: "submitted", userSigns: true, txHashes: [romeTx] },
      {
        n: 2, chain: "ethereum", kind: "wormhole-claim-on-ethereum", status: "blocked", userSigns: true,
        blockedBy: ["step-1", "wormhole-vaa"],
        claimTokenBridge: TOKEN_BRIDGE, claimMethod: "completeTransferAndUnwrapETH",
        romeRpcUrl: "https://hadrian.example",
        ...over,
      },
    ],
    outcome: "pending",
  } as never);
  return { store, id, romeTx };
}

function makePoller(store: TransferStore, opts: {
  vaaByTxHash?: (sig: string) => Promise<{ status: string; vaa?: string }>;
  sigs?: string[];
}) {
  const wormhole = {
    fetch: vi.fn(async () => ({ status: "pending" as const })),
    fetchByTxHash: vi.fn(opts.vaaByTxHash ?? (async () => ({ status: "complete" as const, vaa: VAA_B64 }))),
  };
  const sigResolver = vi.fn(async () => opts.sigs ?? ["5solSig11111111111111111111111111111111111111"]);
  const poller = new AttestationPoller(
    store,
    { fetch: vi.fn(async () => ({ status: "pending" })) } as never, // circle — unused here
    wormhole as never,
    undefined, undefined, undefined, undefined,
    sigResolver as never,
  );
  return { poller, wormhole, sigResolver };
}

describe("poller — wormhole from-rome claim materialization", () => {
  it("VAA signed → step 1 confirmed + claim ready with completeTransferAndUnwrapETH calldata", async () => {
    const { store, id } = await makeWhOutRecord();
    const { poller } = makePoller(store, {});

    await poller.tickOnce(id);

    const record = (await store.get(id))!;
    expect(record.steps[0]!.status).toBe("confirmed");   // VAA existence proves the burn mined
    const claim = record.steps[1]!;
    expect(claim.status).toBe("ready");
    expect(claim.vaa).toBe(VAA_B64);
    expect(claim.unsignedTxs).toHaveLength(1);
    const tx = claim.unsignedTxs![0]!;
    expect(tx.to).toBe(TOKEN_BRIDGE);
    const decoded = decodeFunctionData({ abi: CLAIM_ABI, data: tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("completeTransferAndUnwrapETH");
    expect(Buffer.from((decoded.args![0] as string).slice(2), "hex").toString()).toBe("hello-vaa");
  });

  it("VAA still pending → nothing changes (retry next tick)", async () => {
    const { store, id } = await makeWhOutRecord();
    const { poller } = makePoller(store, { vaaByTxHash: async () => ({ status: "pending" }) });
    await poller.tickOnce(id);
    const record = (await store.get(id))!;
    expect(record.steps[0]!.status).toBe("submitted");
    expect(record.steps[1]!.status).toBe("blocked");
  });

  it("no claimTokenBridge stamped → VAA attached, claim stays for portal redeem (no calldata)", async () => {
    const { store, id } = await makeWhOutRecord({ claimTokenBridge: undefined, claimMethod: undefined });
    const { poller } = makePoller(store, {});
    await poller.tickOnce(id);
    const claim = (await store.get(id))!.steps[1]!;
    expect(claim.vaa).toBe(VAA_B64);
    expect(claim.status).toBe("ready");        // user can redeem via portal with the VAA
    expect(claim.unsignedTxs).toBeUndefined();
  });

  it("already materialized → no re-fetch (idempotent ticks)", async () => {
    const { store, id } = await makeWhOutRecord();
    const { poller, wormhole } = makePoller(store, {});
    await poller.tickOnce(id);
    await poller.tickOnce(id);
    expect(wormhole.fetchByTxHash).toHaveBeenCalledTimes(1);
  });
});
