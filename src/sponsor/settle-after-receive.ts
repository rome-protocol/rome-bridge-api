/**
 * settleAfterReceive — post-receive settle helper for inbound bridges.
 *
 * Mirrors the entry-point shape of the Rome app's `settleAfterReceive`: same
 * outcome enum, same gate semantics, callable in isolation. bridge-api's
 * variant keeps Solana-side construction behind the injected
 * `buildAndSendSettle` hook because the API process holds no on-chain keys.
 * The hook is wired in `run.ts` for production
 * and stubbed in tests.
 *
 * Behavior:
 *   1. If `getMintForChain` is provided, run the OwnerInfo gate — refuse to
 *      settle unless the chain's on-chain gas mint matches the step's
 *      claimed mint. Refusal returns `outcome: "wrapper-only"` (the
 *      bridged SPL stays in the user's PDA-ATA as a wrapped token; no gas
 *      conversion happens).
 *   2. On gate pass (or gate absent), call `buildAndSendSettle`. On success
 *      return `outcome: "all-gas"` with the Solana tx signature; on failure
 *      return `outcome: "settle-skipped"` with a reason.
 *
 * Gate intentionally narrower than the Rome app's `canSettleInboundBridge`:
 * bridge-api verifies the source-tx recipient bytes upfront at
 * `POST /v1/transfers` (see `src/transfers/verify.ts`), so the gate-time
 * attestation-binding check is redundant here. The residual chainId-redirect
 * risk is closed on-chain by the user-signed SettleAuthorization; see
 * docs/BRIDGE_API_ARCHITECTURE.md for the full rationale.
 */
import { PublicKey, type Keypair } from "@solana/web3.js";
import type { SendSettleInput, GetMintForChain } from "./bridge-sponsor.js";

export interface SettleStepInput {
  chainId: string;                  // bigint as decimal string
  user: `0x${string}`;              // 20-byte EVM addr
  bridgedAmount: string;            // bigint as decimal string, mint base units
  sourceChain: string;              // bigint as decimal string
  sourceTxHash: `0x${string}`;      // 32-byte source-chain tx hash
  rollupProgramId: string;          // base58
  mintAddress: string;              // base58 — the chain's gas mint claimed by the step
}

export type SettleOutcome =
  | "all-gas"           // settle tx submitted; signature returned
  | "wrapper-only"      // gate refused; bridged SPL stays as a wrapper
  | "settle-skipped";   // gate passed but hook failed (rpc, unwired, etc.)

export interface SettleAfterReceiveResult {
  outcome: SettleOutcome;
  /** Populated iff outcome === "all-gas". The Solana settle tx signature. */
  settleTxHash?: string;
  /** Informational reason on non-happy paths. */
  reason?: string;
}

export interface SettleAfterReceiveOpts {
  step: SettleStepInput;
  signer: Keypair;
  buildAndSendSettle: (input: SendSettleInput) => Promise<string>;
  /** Optional — when present, the OwnerInfo gate runs and can refuse settle. */
  getMintForChain?: GetMintForChain;
}

export async function settleAfterReceive(
  opts: SettleAfterReceiveOpts,
): Promise<SettleAfterReceiveResult> {
  // ── OwnerInfo gate ──
  if (opts.getMintForChain) {
    const onchain = await opts.getMintForChain(
      BigInt(opts.step.chainId), new PublicKey(opts.step.rollupProgramId),
    );
    if (!onchain) {
      return {
        outcome: "wrapper-only",
        reason: "OwnerInfo did not return a mint for this chain; refusing to settle",
      };
    }
    if (onchain.toBase58() !== opts.step.mintAddress) {
      return {
        outcome: "wrapper-only",
        reason: `OwnerInfo mint ${onchain.toBase58()} != step.mintAddress ${opts.step.mintAddress}; refusing to settle`,
      };
    }
  }

  // ── Build + send via hook ──
  let signature: string;
  try {
    signature = await opts.buildAndSendSettle({
      chainId: opts.step.chainId,
      user: opts.step.user,
      bridgedAmount: opts.step.bridgedAmount,
      sourceChain: opts.step.sourceChain,
      sourceTxHash: opts.step.sourceTxHash,
      rollupProgramId: opts.step.rollupProgramId,
      mintAddress: opts.step.mintAddress,
      signer: opts.signer,
    });
  } catch (e) {
    return {
      outcome: "settle-skipped",
      reason: `settle send failed: ${(e as Error).message}`,
    };
  }

  return { outcome: "all-gas", settleTxHash: signature };
}
