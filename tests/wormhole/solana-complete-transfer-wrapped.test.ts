// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { buildCompleteTransferWrappedInstruction } from "../../src/wormhole/solana-complete-transfer-wrapped.js";

// Build a synthetic VAA for the SDK's deserialize step — Sepolia → Solana
// wrapped-ETH transfer shape. The SDK accepts unsigned VAAs for the
// `complete_transfer_wrapped` deserialization path (signatures are checked
// later, on-chain, by the Wormhole Core Bridge program).
function syntheticVaaBase64(): string {
  const bodyPrefix =
    "12345678" + "00000001" + "2712" +           // timestamp + nonce + emitterChain=10002 (Sepolia)
    "00".repeat(12) + "db5492265f6038831e89f495670ff909ade94bd9" + // emitter = Sepolia TB padded to 32B
    "0000000000000064" + "00";                    // sequence + consistency
  const payload =
    "01" +                                        // type = Transfer
    "00".repeat(24) + "00000000000f4240" +        // amount 1,000,000 (1e6 / 1 unit at 6 dec)
    "00".repeat(12) + "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c" + // tokenAddress
    "2712" +                                      // tokenChain = 10002
    "aeb1da9640c012e56d973efd21a2bc76384d059250b2c1895ca926d27241f493" + // to (32 bytes)
    "0001" +                                      // toChain = 1 (Solana)
    "00".repeat(32);                              // fee
  const vaaHex = "01" + "00000000" + "00" + bodyPrefix + payload;
  return Buffer.from(vaaHex, "hex").toString("base64");
}

describe("buildCompleteTransferWrappedInstruction", () => {
  // Regression guard ported from the Rome app (bug fixed 2026-05-17): a prior
  // version hardcoded Token Bridge + Core program IDs to devnet values.
  // On any mainnet chain config the caller threads `wormholeTokenBridgeProgram`
  // + `wormholeCoreProgram` from registry, but if the builder ignored them
  // the worker silently submitted against devnet programs → VAA never landed.
  // This test threads MAINNET program IDs through and asserts the returned
  // instruction targets them, not the devnet defaults.
  it("targets the Token Bridge program ID provided by the caller (not a devnet default)", async () => {
    const payer = Keypair.generate().publicKey;
    const vaaBase64 = syntheticVaaBase64();
    const mockConn = { getAccountInfo: vi.fn(async () => null) } as unknown as Connection;

    const mainnetTokenBridge = new PublicKey("wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb");
    const mainnetWormholeCore = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

    const ix = await buildCompleteTransferWrappedInstruction({
      payer, vaaBase64, connection: mockConn,
      tokenBridgePid: mainnetTokenBridge,
      wormholeCorePid: mainnetWormholeCore,
    });
    expect(ix.programId.toBase58()).toBe(mainnetTokenBridge.toBase58());
    expect(ix.programId.toBase58()).not.toBe("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
  });

  it("also accepts the devnet program IDs when the caller passes them (back-compat)", async () => {
    const payer = Keypair.generate().publicKey;
    const vaaBase64 = syntheticVaaBase64();
    const mockConn = { getAccountInfo: vi.fn(async () => null) } as unknown as Connection;

    const devnetTokenBridge = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
    const devnetWormholeCore = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");

    const ix = await buildCompleteTransferWrappedInstruction({
      payer, vaaBase64, connection: mockConn,
      tokenBridgePid: devnetTokenBridge,
      wormholeCorePid: devnetWormholeCore,
    });
    expect(ix.programId.toBase58()).toBe(devnetTokenBridge.toBase58());
  });
});
