import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import { buildUsdcCctpInboundQuote } from "../../src/route-builders/usdc-cctp-inbound";
import { loadFixtureChain, syntheticChain, USDC_DEVNET_MINT } from "../helpers/chains";

const V2_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);
const V2_SELECTOR = toFunctionSelector("function depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)");
const V1_SELECTOR = "0x6fd3504e"; // canonical CCTP V1 depositForBurn

const HADRIAN = await loadFixtureChain("200010");
const SAMPLE_EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";
const base = {
  amount: "1000000",
  sender: { ethereum: SAMPLE_EVM },
  recipient: SAMPLE_EVM,
  chain: HADRIAN,
  programId: HADRIAN.romeEvmProgramId!,
  intent: "gas" as const,
};

const burnTx = (q: ReturnType<typeof buildUsdcCctpInboundQuote>) => q.steps[0]!.unsignedTxs!.at(-1)!;

describe("V2 quote calldata — 7-arg depositForBurn (published Hadrian catalog)", () => {
  it("Sepolia (declared V2, distinct V1 history): burn targets the V2 messenger with V2 args", () => {
    const q = buildUsdcCctpInboundQuote(base);
    expect(q.cctpVersion).toBe(2);
    expect(q.sourceChainId).toBe(11155111);
    expect(q.speed).toBe("standard");
    const tx = burnTx(q);
    expect(tx.to).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"); // cctpTokenMessengerV2, NOT the V1 0x9f3B
    expect(tx.data.slice(0, 10)).toBe(V2_SELECTOR);
    const { args } = decodeFunctionData({ abi: V2_ABI, data: tx.data as `0x${string}` });
    expect(args[0]).toBe(1000000n);                       // amount
    expect(args[1]).toBe(5);                              // destinationDomain (registry solana.cctpDomain)
    expect(args[3].toLowerCase()).toBe("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"); // Sepolia USDC asset row
    expect(args[4]).toBe("0x" + "0".repeat(64));          // destinationCaller = 0 — receive stays permissionless
    expect(args[5]).toBe(0n);                             // maxFee 0 for standard
    expect(args[6]).toBe(2000);                           // minFinalityThreshold standard
    // approve target == burn target, same catalog entry
    expect(q.steps[0]!.unsignedTxs![0]!.data.slice(34, 74)).toBe(tx.to.slice(2).toLowerCase().padStart(40, "0"));
  });

  it("Monad via sourceChainId: same V2 messenger, Monad's burn token, still destination domain 5", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, sourceChainId: 10143 });
    expect(q.sourceChainId).toBe(10143);
    const tx = burnTx(q);
    expect(tx.to).toBe("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
    const { args } = decodeFunctionData({ abi: V2_ABI, data: tx.data as `0x${string}` });
    expect((args[3] as string).toLowerCase()).toBe("0x534b2f3a21130d7a60830c2df862319e593943a3"); // usdc-monad row
    expect(args[1]).toBe(5);
    expect(q.steps[0]!.chain).toBe("evm-10143"); // catalog sources get evm-<id>; default keeps "ethereum"
    expect(q.etaSeconds).toBe(30);
  });

  it("every catalog source quotes with zero per-chain code (the any-chain gate)", () => {
    for (const chainId of [11155111, 10143, 80002, 421614, 84532, 43113]) {
      const q = buildUsdcCctpInboundQuote({ ...base, sourceChainId: chainId });
      expect(q.cctpVersion, `source ${chainId}`).toBe(2);
      expect(burnTx(q).data.slice(0, 10)).toBe(V2_SELECTOR);
      expect(q.steps[0]!.unsignedTxs![0]!.data.slice(34, 74)).toBe(burnTx(q).to.slice(2).toLowerCase().padStart(40, "0"));
    }
  });

  it("unknown source fails closed", () => {
    expect(() => buildUsdcCctpInboundQuote({ ...base, sourceChainId: 424242 })).toThrow(/not in the registry/);
  });

  it("V2 receive step stamps the V2 Solana programs", () => {
    const q = buildUsdcCctpInboundQuote(base);
    const programs = q.steps.find((s) => s.kind === "cctp-receive-message")!.programs!;
    expect(programs.messageTransmitterProgram).toBe("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
    expect(programs.tokenMessengerMinterProgram).toBe("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
  });
});

describe("fast transfer — probe-driven, fail-closed", () => {
  it("fast + available: minFinality 1000, ceil maxFee, fee line item, conservative amountOut", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, speed: "fast", fast: { available: true, bps: 1 } });
    expect(q.speed).toBe("fast");
    const { args } = decodeFunctionData({ abi: V2_ABI, data: burnTx(q).data as `0x${string}` });
    expect(args[6]).toBe(1000);
    expect(args[5]).toBe(100n); // ceil(1000000 * 1bps / 10000) = 100
    expect(q.fees).toEqual([{ type: "circle-fast-transfer", bps: 1, amount: "100", asset: "USDC", paidTo: "circle" }]);
    expect(q.amountOut).toBe("999900");
    expect(q.outputs![0]!.amount).toBe("999900");
    expect(q.etaSeconds).toBe(40);
  });

  it("fast requested but unavailable (Monad class): fails closed to a standard quote", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, sourceChainId: 10143, speed: "fast", fast: { available: false } });
    expect(q.speed).toBe("standard");
    expect(q.fees).toBeUndefined();
    const { args } = decodeFunctionData({ abi: V2_ABI, data: burnTx(q).data as `0x${string}` });
    expect(args[5]).toBe(0n);
    expect(args[6]).toBe(2000);
    expect(q.amountOut).toBe("1000000");
  });

  it("maxFee rounds UP (never underquotes Circle)", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, amount: "1000001", speed: "fast", fast: { available: true, bps: 1 } });
    const { args } = decodeFunctionData({ abi: V2_ABI, data: burnTx(q).data as `0x${string}` });
    expect(args[5]).toBe(101n); // ceil(100.0001)
  });

  it("fractional bps (Arbitrum/Base Sepolia charge ~1.3): quotes without throwing on BigInt(1.3)", () => {
    // Circle's fast minimumFee is fractional for some routes; BigInt(1.3) throws
    // ("cannot be converted to a BigInt because it is not an integer") — the server
    // /v1/quote 500 on 421614 + 84532. maxFee = ceil(amount * 1.3bps / 10000).
    const q = buildUsdcCctpInboundQuote({ ...base, speed: "fast", fast: { available: true, bps: 1.3 } });
    expect(q.speed).toBe("fast");
    const { args } = decodeFunctionData({ abi: V2_ABI, data: burnTx(q).data as `0x${string}` });
    expect(args[5]).toBe(130n); // ceil(1000000 * 1.3 / 10000) = 130
    expect(q.fees).toEqual([{ type: "circle-fast-transfer", bps: 1.3, amount: "130", asset: "USDC", paidTo: "circle" }]);
    expect(q.amountOut).toBe("999870");
  });

  it("fractional bps still rounds the fee UP (never underquotes Circle)", () => {
    // 1000001 * 1.3 / 10000 = 130.00013 -> ceil 131
    const q = buildUsdcCctpInboundQuote({ ...base, amount: "1000001", speed: "fast", fast: { available: true, bps: 1.3 } });
    const { args } = decodeFunctionData({ abi: V2_ABI, data: burnTx(q).data as `0x${string}` });
    expect(args[5]).toBe(131n);
  });
});

describe("V1 emission — only for v1 entries, refusable by flag", () => {
  const v1Chain = syntheticChain({
    chainId: "121301",
    gasMintId: USDC_DEVNET_MINT,
    bridge: {
      cctpIrisApiBase: "https://iris-api-sandbox.circle.com",
      sourceEvm: { chainId: 11155111, cctpTokenMessenger: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5", cctpMessageTransmitter: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD" },
      solana: { cctpDomain: 5 },
      assets: [{ symbol: "USDC", solanaMint: USDC_DEVNET_MINT, sourceEvm: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", protocol: "cctp" } }],
    },
  });

  it("a v1 entry (no declared version) still emits 4-arg V1 calldata to the V1 messenger", () => {
    const q = buildUsdcCctpInboundQuote({ ...base, chain: v1Chain });
    expect(q.cctpVersion).toBe(1);
    const tx = burnTx(q);
    expect(tx.to).toBe("0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5");
    expect(tx.data.slice(0, 10)).toBe(V1_SELECTOR);
    expect(q.steps[1]!.programs!.messageTransmitterProgram).toBe("CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd");
  });

  it("BRIDGE_REFUSE_V1_QUOTES=1 refuses v1 emission (Phase-2 flag)", () => {
    process.env.BRIDGE_REFUSE_V1_QUOTES = "1";
    try {
      expect(() => buildUsdcCctpInboundQuote({ ...base, chain: v1Chain })).toThrow(/V1.*disabled|phased/i);
    } finally {
      delete process.env.BRIDGE_REFUSE_V1_QUOTES;
    }
  });
});
