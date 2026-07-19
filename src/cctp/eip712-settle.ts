/**
 * EIP-712 SettleAuthorization digest.
 *
 * The user signs this off-chain; the Rome EVM's settle_inbound_bridge_v2
 * recomputes the identical digest on-chain and requires secp256k1_recover to
 * yield the user. Both sides MUST agree byte-for-byte — the Rust unit tests
 * and tests/cctp/settle-v2.test.ts pin the same golden vector.
 *
 * domain = { name: "Rome Bridge Settlement", version: "1",
 *            chainId: <source EVM chain>, salt: keccak256(romeEvmProgramId) }
 */
import { PublicKey } from "@solana/web3.js";
import { hashTypedData, keccak256, toHex, type Hex } from "viem";

export const SETTLE_AUTHORIZATION_TYPEHASH =
  "0xcc0b6054aab1503241e0113fa29f2884671758182841fc8d81143b128671d6b4";

const SETTLE_TYPES = {
  // EIP712Domain must be EXPLICIT (viem's canonical field order, matching the
  // domain object's fields). viem's hashTypedData auto-derives it from the
  // domain, but MetaMask's eth_signTypedData_v4 (eth-sig-util) falls back to
  // an EMPTY domain type when types.EIP712Domain is absent — the separator
  // degenerates to keccak256(keccak256("EIP712Domain()")), the wallet signs a
  // different digest than the server verifies, and recovery lands on garbage.
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "salt", type: "bytes32" },
  ],
  SettleAuthorization: [
    { name: "destinationChainId", type: "uint64" },
    { name: "mint", type: "bytes32" },
    { name: "amount", type: "uint64" },
    { name: "sourceChain", type: "uint64" },
    { name: "sourceTxHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface SettleAuthorizationParams {
  romeEvmProgramId: PublicKey;
  /** EIP-712 domain.chainId — the source EVM chain where the user signs. */
  sourceEvmChainId: bigint;
  destinationChainId: bigint;
  mint: PublicKey;
  amount: bigint;
  sourceChain: bigint;
  /** 0x-hex 32-byte source tx hash. */
  sourceTxHash: Hex;
  deadline: bigint;
}

export function settleAuthorizationTypedData(p: SettleAuthorizationParams) {
  return {
    domain: {
      name: "Rome Bridge Settlement",
      version: "1",
      chainId: p.sourceEvmChainId,
      salt: keccak256(toHex(p.romeEvmProgramId.toBytes())),
    },
    types: SETTLE_TYPES,
    primaryType: "SettleAuthorization" as const,
    message: {
      destinationChainId: p.destinationChainId,
      mint: toHex(p.mint.toBytes()),
      amount: p.amount,
      sourceChain: p.sourceChain,
      sourceTxHash: p.sourceTxHash,
      deadline: p.deadline,
    },
  };
}

/** The 32-byte digest the user signs (and the program recomputes). */
export function settleAuthorizationDigest(p: SettleAuthorizationParams): Hex {
  return hashTypedData(settleAuthorizationTypedData(p));
}
