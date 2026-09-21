import { QuoteStep, UnsignedEvmTx } from "../route-builders/usdc-cctp-inbound.js";
import type { RecordStampT } from "./types.js";
import { contractAtAddress } from "../registry/contracts.js";
import type { ChainConfig } from "../registry/types.js";

export interface OnchainEvmTx { to: string; data: string; value: string; }
export interface VerifyResult { ok: boolean; reason?: string; warning?: string; }

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
export function verifyEvmTxMatchesQuote(
  quotedStep: QuoteStep,
  tx: OnchainEvmTx,
  stamp?: RecordStampT,
  chain?: Pick<ChainConfig, "contracts">,
): VerifyResult {
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

  // Everything above proves the tx matches the QUOTE. For Rome-side egress
  // that is not enough: the quote resolved RomeBridgeWithdraw by status when
  // it was built, so a quote issued before a rotation still satisfies every
  // check above after it — and the burn lands on a contract the registry has
  // already moved off. Grade the target by its CURRENT status.
  //
  // Addresses the registry does not list are left ungraded on purpose: every
  // inbound burn targets CCTP's TokenMessenger on a foreign chain, and
  // treating unknown as bad would reject the entire inbound lane.
  if (chain) {
    const target = contractAtAddress(chain, tx.to);
    if (target) {
      const successor = target.liveAddress ? ` The live ${target.name} is ${target.liveAddress}.` : "";
      if (target.status === "retired") {
        return {
          ok: false,
          reason: `${target.name}${target.version ? ` ${target.version}` : ""} at ${tx.to} is retired in the registry — this quote predates a rotation.${successor}`,
        };
      }
      if (target.status === "deprecated") {
        return {
          ok: true,
          warning: `${target.name}${target.version ? ` ${target.version}` : ""} at ${tx.to} is deprecated in the registry; settle this transfer, but re-quote before issuing new ones.${successor}`,
        };
      }
    }
  }

  return { ok: true };
}
