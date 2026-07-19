/**
 * Version-blind CCTP message view.
 *
 * Both lenses expose the same shared shape so downstream stages (poller,
 * verification, settle math) never branch on the wire format. The normalized
 * `nonce` is 32-byte 0x-hex — V1's u64 left-padded — while the raw per-version
 * forms stay available because the Solana receive PDA derivation genuinely
 * branches (V1 bucketed used_nonces math on the u64 vs V2 one-PDA-per-nonce).
 */
import { parseCctpMessage } from "./message.js";
import { parseCctpMessageV2 } from "./message-v2.js";

export interface CctpMessageView {
  cctpVersion: 1 | 2;
  sourceDomain: number;
  destDomain: number;
  /** Normalized 32-byte 0x-hex nonce (V1 left-padded). */
  nonce: `0x${string}`;
  /** V1 only — the raw sequential u64 (bucketed used_nonces derivation). */
  nonceU64: bigint | undefined;
  /** V2 only — the raw 32-byte iris-assigned nonce (per-nonce PDA derivation). */
  nonceBytes32: Uint8Array | undefined;
  sender: Uint8Array;
  recipient: Uint8Array;
  destCaller: Uint8Array;
  burnToken: Uint8Array;
  burnToken20: Uint8Array;
  mintRecipient: Uint8Array;
  amount: bigint;
  messageSender: Uint8Array;
  /** V2 only. */
  minFinalityThreshold: number | undefined;
  finalityThresholdExecuted: number | undefined;
  maxFee: bigint | undefined;
  feeExecuted: bigint | undefined;
  expirationBlock: bigint | undefined;
}

export function parseCctpMessageView(msg: Uint8Array, version: 1 | 2): CctpMessageView {
  if (version === 2) {
    const p = parseCctpMessageV2(msg);
    return {
      cctpVersion: 2,
      sourceDomain: p.sourceDomain,
      destDomain: p.destDomain,
      nonce: ("0x" + Buffer.from(p.nonce).toString("hex")) as `0x${string}`,
      nonceU64: undefined,
      nonceBytes32: p.nonce,
      sender: p.sender,
      recipient: p.recipient,
      destCaller: p.destCaller,
      burnToken: p.burnToken,
      burnToken20: p.burnToken20,
      mintRecipient: p.mintRecipient,
      amount: p.amount,
      messageSender: p.messageSender,
      minFinalityThreshold: p.minFinalityThreshold,
      finalityThresholdExecuted: p.finalityThresholdExecuted,
      maxFee: p.maxFee,
      feeExecuted: p.feeExecuted,
      expirationBlock: p.expirationBlock,
    };
  }
  const p = parseCctpMessage(msg);
  return {
    cctpVersion: 1,
    sourceDomain: p.sourceDomain,
    destDomain: p.destDomain,
    nonce: ("0x" + p.nonce.toString(16).padStart(64, "0")) as `0x${string}`,
    nonceU64: p.nonce,
    nonceBytes32: undefined,
    sender: p.sender,
    recipient: p.recipient,
    destCaller: p.destCaller,
    burnToken: p.burnToken,
    burnToken20: p.burnToken20,
    mintRecipient: p.mintRecipient,
    amount: p.amount,
    messageSender: p.messageSender,
    minFinalityThreshold: undefined,
    finalityThresholdExecuted: undefined,
    maxFee: undefined,
    feeExecuted: undefined,
    expirationBlock: undefined,
  };
}
