import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { buildUsdcCctpOutboundQuote } from "../../src/route-builders/usdc-cctp-outbound";
import { liveContractAddress } from "../../src/registry/contracts";
import { loadFixtureChain } from "../helpers/chains";

const V6_ABI = parseAbi(["function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain)"]);
const V6_SELECTOR = toFunctionSelector("function burnUSDC(uint256,address,uint32)"); // 0x7ed19660

const HADRIAN = await loadFixtureChain("200010");
const RECIPIENT = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";
const base = {
  amount: "1000000",
  sender: { rome: RECIPIENT },
  recipient: RECIPIENT,
  chain: HADRIAN,
  programId: HADRIAN.romeEvmProgramId!,
};

describe("registry contracts merge", () => {
  it("chain config carries contracts.json; live-version resolution ignores retired entries", async () => {
    const live = liveContractAddress(HADRIAN, "RomeBridgeWithdraw");
    expect(live).toBe("0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b"); // v6, status live — never a pinned constant
    expect(liveContractAddress(HADRIAN, "NoSuchContract")).toBeUndefined();
  });
});

describe("outbound V2 quotes — per-call destination via the live v6 contract", () => {
  it("burn targets the registry-live RomeBridgeWithdraw with 3-arg calldata (Monad destination)", () => {
    const q = buildUsdcCctpOutboundQuote({ ...base, destinationChainId: 10143 });
    const burn = q.steps[0]!.unsignedTxs![0]!;
    expect(burn.to).toBe("0x9975fe4b721bf52f2a5bcc795fa2e29edc50de8b");
    expect(burn.data.slice(0, 10)).toBe(V6_SELECTOR);
    const { args } = decodeFunctionData({ abi: V6_ABI, data: burn.data as `0x${string}` });
    expect(args[0]).toBe(1000000n);
    expect((args[1] as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
    expect(args[2]).toBe(15); // Monad's CCTP domain from the catalog
    expect(q.destinationChainId).toBe(10143);
    expect(q.cctpVersion).toBe(2);
  });

  it("destination omitted → the chain's default source entry (Sepolia, domain 0)", () => {
    const q = buildUsdcCctpOutboundQuote(base);
    const { args } = decodeFunctionData({ abi: V6_ABI, data: q.steps[0]!.unsignedTxs![0]!.data as `0x${string}` });
    expect(args[2]).toBe(0);
  });

  it("claim step carries the destination's V2 transmitter + gates on attestation", () => {
    const q = buildUsdcCctpOutboundQuote({ ...base, destinationChainId: 10143 });
    const claim = q.steps[1]!;
    expect(claim.kind).toBe("cctp-claim-on-destination");
    expect(claim.chain).toBe("evm-10143");
    expect(claim.blockedBy).toEqual(["step-1", "circle-attestation"]);
    expect(claim.userSigns).toBe(true); // Tier-1: the user redeems on the destination
    expect(claim.claimTransmitter).toBe("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
  });

  it("every catalog destination quotes with zero per-chain code (Sepolia included)", () => {
    for (const chainId of [11155111, 10143, 80002, 421614, 84532, 43113]) {
      const q = buildUsdcCctpOutboundQuote({ ...base, destinationChainId: chainId });
      expect(q.steps[1]!.claimTransmitter, `destination ${chainId}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("unknown destinations and missing live contract fail closed", () => {
    expect(() => buildUsdcCctpOutboundQuote({ ...base, destinationChainId: 424242 })).toThrow(/destination/i);
    const chainNoContract = { ...HADRIAN, contracts: [] };
    expect(() => buildUsdcCctpOutboundQuote({ ...base, chain: chainNoContract })).toThrow(/RomeBridgeWithdraw/);
  });
});
