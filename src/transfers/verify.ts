import { QuoteStep, UnsignedEvmTx } from "../route-builders/usdc-cctp-inbound.js";
import type { RecordStampT } from "./types.js";

export interface OnchainEvmTx { to: string; data: string; value: string; }
export interface VerifyResult { ok: boolean; reason?: string; }

/** Canonical depositForBurn selectors per CCTP version. */
const SELECTOR_BY_VERSION: Record<1 | 2, string> = {
  1: "0x6fd3504e", // depositForBurn(uint256,uint32,bytes32,address)
  2: "0x8e0250ee", // depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32) — asserted against viem in tests
};

/**
 * equality-only verification, optionally bound to the record stamp
 *: the burn must target the REGISTRY-stamped
 * messenger and carry the recorded version's selector — a caller-supplied
 * quote can't verify against a contract or version the registry never
 * resolved, and a catalog edit after registration can't retarget it (the
 * stamp is frozen, never re-resolved). chainId is enforced by fetching the
 * tx via the record's own source-chain client, not by a field compare.
 */
export function verifyEvmTxMatchesQuote(quotedStep: QuoteStep, tx: OnchainEvmTx, stamp?: RecordStampT): VerifyResult {
  if (!quotedStep.unsignedTxs?.length) return { ok: false, reason: "step has no unsigned txs" };
  // Verify against the LAST element of unsignedTxs, not the first. CCTP inbound
  // emits [approve, depositForBurn] — the load-bearing tx is the deposit (carries
  // mintRecipient bytes32 = the pinned Solana ATA). Future routes may prepend
  // additional setup txs (extra approves, batched ATA creates, etc.); always
  // verify the final user-signed binding tx. Do not change to [0] — that would
  // bind on the setup tx and leave the actual transfer destination unverified.
  const last = quotedStep.unsignedTxs[quotedStep.unsignedTxs.length - 1] as UnsignedEvmTx;

  if (tx.to.toLowerCase() !== last.to.toLowerCase()) return { ok: false, reason: `to mismatch: expected ${last.to}, got ${tx.to}` };
  const expectedSelector = last.data.slice(0, 10).toLowerCase();
  const actualSelector   = tx.data.slice(0, 10).toLowerCase();
  if (actualSelector !== expectedSelector)            return { ok: false, reason: `selector mismatch: expected ${expectedSelector}, got ${actualSelector}` };
  if (tx.data.toLowerCase() !== last.data.toLowerCase()) return { ok: false, reason: "data (args) mismatch" };
  if (BigInt(tx.value) !== BigInt(last.value))        return { ok: false, reason: `value mismatch: expected ${last.value}, got ${tx.value}` };

  if (stamp?.cctpTokenMessenger && tx.to.toLowerCase() !== stamp.cctpTokenMessenger.toLowerCase()) {
    return { ok: false, reason: `burn target ${tx.to} is not the stamped messenger ${stamp.cctpTokenMessenger}` };
  }
  const allowedSelectors = stamp?.expectedSelectors ?? (stamp ? [SELECTOR_BY_VERSION[stamp.cctpVersion]] : undefined);
  if (allowedSelectors && !allowedSelectors.includes(actualSelector)) {
    return { ok: false, reason: `selector ${actualSelector} is not among the stamped burn selectors [${allowedSelectors.join(", ")}]` };
  }

  return { ok: true };
}
