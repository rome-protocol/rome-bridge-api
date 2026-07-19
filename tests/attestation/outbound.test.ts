import { describe, it, expect, vi } from "vitest";
import RedisMock from "ioredis-mock";
import { decodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { AttestationPoller } from "../../src/attestation/poller";
import { TransferStore } from "../../src/transfers/store";
import { verifyEvmTxMatchesQuote } from "../../src/transfers/verify";
import type { RecordStampT } from "../../src/transfers/types";

const V6_WITHDRAW = "0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b";
const V6_SELECTOR = toFunctionSelector("function burnUSDC(uint256,address,uint32)");
const TRANSMITTER = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275";
const RECEIVE_ABI = parseAbi(["function receiveMessage(bytes message, bytes attestation)"]);

const OUTBOUND_STAMP: RecordStampT = {
  sourceChainId: 200010,           // the ROME chain — where the burn tx lives
  cctpVersion: 2,
  cctpDomain: 5,                   // the POLL domain: Solana originates the message
  irisBase: "https://iris-api-sandbox.circle.com",
  cctpTokenMessenger: V6_WITHDRAW, // burn-target binding for the spec
  expectedSelectors: [V6_SELECTOR],
  romeRpcUrl: "https://hadrian.example",
};

let burnCounter = 0;
async function makeOutboundRecord() {
  const redis = new RedisMock() as unknown as import("ioredis").Redis;
  const store = new TransferStore(redis);
  const romeTx = `0xromeburn${++burnCounter}`; // ioredis-mock shares state — unique natural keys per test
  const id = await store.create({
    route: "usdc-cctp-from-rome", direction: "from-rome", amountIn: "1", amountOut: "1",
    sender: { rome: "0xabc" }, recipient: "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562",
    steps: [
      { n: 1, chain: "rome-200010", kind: "cctp-burn-usdc", status: "submitted", txHashes: [romeTx] },
      { n: 2, chain: "evm-10143", kind: "cctp-claim-on-destination", status: "blocked", blockedBy: "step-1", claimTransmitter: TRANSMITTER, claimDomain: 15 },
    ],
    outcome: "pending",
    stamp: OUTBOUND_STAMP,
  });
  return { store, id, romeTx };
}

describe("poller — outbound leg (Rome burn → Solana-origin iris v2 → destination claim)", () => {
  it("resolves Solana sigs via the Rome proxy hook, polls domain 5, materializes the claim calldata", async () => {
    const { store, id } = await makeOutboundRecord();
    const solanaSigResolver = vi.fn().mockResolvedValue(["5qSolanaSigOfBurn"]);
    const v2 = {
      fetchByTxHash: vi.fn().mockResolvedValue({ status: "complete", message: "0x" + "11".repeat(376), attestation: "0x" + "22".repeat(130) }),
      fetchByNonce: vi.fn(),
    };
    const poller = new AttestationPoller(store, { fetch: vi.fn() } as never, undefined, undefined, undefined, v2 as never, undefined, solanaSigResolver);
    await poller.tickOnce(id);

    expect(solanaSigResolver).toHaveBeenCalledWith("https://hadrian.example", expect.stringMatching(/^0xromeburn/));
    expect(v2.fetchByTxHash).toHaveBeenCalledWith("https://iris-api-sandbox.circle.com", 5, "5qSolanaSigOfBurn");
    const record = await store.get(id);
    // Attestation proves the burn mined — step 1 confirms (parity with the
    // Wormhole outbound branch; without this, outbound records could never
    // reach outcome: complete and clients rendered a forever-pending burn).
    expect(record!.steps[0]!.status).toBe("confirmed");
    const claim = record!.steps[1]!;
    expect(claim.status).toBe("ready");
    // A user-paid claim never expires: Circle attestations stay valid
    // indefinitely, and the old +90s stamp made clients honoring expiresAt
    // treat every claim older than 90s as dead (operator repro 2026-07-09).
    expect(claim.expiresAt).toBeUndefined();
    const tx = (claim.unsignedTxs as Array<{ to: string; data: string }>)[0]!;
    expect(tx.to).toBe(TRANSMITTER);
    const { functionName, args } = decodeFunctionData({ abi: RECEIVE_ABI, data: tx.data as `0x${string}` });
    expect(functionName).toBe("receiveMessage");
    expect(args[0]).toBe("0x" + "11".repeat(376));
    expect(args[1]).toBe("0x" + "22".repeat(130));
  });

  it("sig resolved but attestation pending → sigs cached on the step, stays blocked, resolver not re-called", async () => {
    const { store, id } = await makeOutboundRecord();
    const solanaSigResolver = vi.fn().mockResolvedValue(["5qSig"]);
    const v2 = { fetchByTxHash: vi.fn().mockResolvedValue({ status: "pending" }), fetchByNonce: vi.fn() };
    const poller = new AttestationPoller(store, { fetch: vi.fn() } as never, undefined, undefined, undefined, v2 as never, undefined, solanaSigResolver);
    await poller.tickOnce(id);
    expect((await store.get(id))!.steps[1]!.status).toBe("blocked");
    expect((await store.get(id))!.steps[1]!.solanaSigs).toEqual(["5qSig"]);
    await poller.tickOnce(id);
    expect(solanaSigResolver).toHaveBeenCalledTimes(1); // cached after the first resolve
  });
});

describe("verification — outbound stamps carry registry-derived v6 selectors", () => {
  const step = {
    n: 1, chain: "rome-200010", kind: "cctp-burn-usdc",
    unsignedTxs: [{ to: V6_WITHDRAW, data: V6_SELECTOR + "ab".repeat(96), value: "0", estimatedGas: "1", description: "burn" }],
  };
  const onchain = { to: V6_WITHDRAW, data: V6_SELECTOR + "ab".repeat(96), value: "0" };

  it("accepts the v6 burn under the outbound stamp", () => {
    expect(verifyEvmTxMatchesQuote(step, onchain, OUTBOUND_STAMP).ok).toBe(true);
  });

  it("rejects a depositForBurn selector under the outbound stamp (wrong contract family)", () => {
    const bad = { ...step, unsignedTxs: [{ ...step.unsignedTxs[0]!, data: "0x8e0250ee" + "ab".repeat(96) }] };
    const r = verifyEvmTxMatchesQuote(bad, { ...onchain, data: "0x8e0250ee" + "ab".repeat(96) }, OUTBOUND_STAMP);
    expect(r.ok).toBe(false);
  });
});
