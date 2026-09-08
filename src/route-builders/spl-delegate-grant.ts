import { encodeFunctionData, parseAbi, bytesToHex } from "viem";
import { PublicKey } from "@solana/web3.js";
import { bridgeError } from "../errors.js";
import type { UnsignedEvmTx } from "./usdc-cctp-inbound.js";

/**
 * RomeBridgeWithdraw (v10+) moves a user's SPL as that user's SPL DELEGATE:
 * the contract signs as external_auth(bridge), which SPL Token accepts as either
 * owner or delegate of the source ATA. The user grants that with their own
 * transaction straight to HelperProgram — never through the bridge — so it is
 * the FIRST tx of every Rome-outbound step 1. The burn / bridge-out stays the
 * LAST tx: registration binds step1TxHash to the last unsignedTx.
 *
 * `approve_spl(address spender, uint64 amount, bytes32 mint)` sets the delegate
 * and `delegated_amount` on the user's ATA for `mint`. SPL Token has ONE
 * delegate slot per ATA, so the grant to the bridge replaces any earlier grant
 * (e.g. to a wrapper) on the same mint; `delegated_amount` decrements per
 * transfer, so granting the exact burn amount covers exactly this burn.
 */
export const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as const;

const HELPER_ABI = parseAbi(["function approve_spl(address spender, uint64 amount, bytes32 mint)"]);
const U64_MAX = 2n ** 64n - 1n;

export function buildSplDelegateGrantTx(args: {
  bridge: `0x${string}`;
  /** In the SPL mint's own units (the wrapper's decimals), not the 18-dec route scale. */
  amount: bigint;
  /** Solana mint, base58. */
  mint: string;
  /** Wrapper symbol for the human-readable description. */
  symbol: string;
}): UnsignedEvmTx {
  if (args.amount < 0n || args.amount > U64_MAX) {
    throw bridgeError("rome.bridge.amount-out-of-range", `amount ${args.amount} does not fit the on-chain uint64 approve`);
  }
  let mintBytes32: `0x${string}`;
  try {
    mintBytes32 = bytesToHex(new PublicKey(args.mint).toBytes());
  } catch {
    throw bridgeError("rome.bridge.asset-not-supported", `mint ${args.mint} is not a valid Solana pubkey`);
  }
  return {
    to: HELPER_PROGRAM,
    data: encodeFunctionData({ abi: HELPER_ABI, functionName: "approve_spl", args: [args.bridge, args.amount, mintBytes32] }),
    value: "0",
    estimatedGas: "150000",
    description: `Grant RomeBridgeWithdraw delegate rights over ${args.symbol} on Solana (approve_spl; required once before the burn)`,
  };
}
