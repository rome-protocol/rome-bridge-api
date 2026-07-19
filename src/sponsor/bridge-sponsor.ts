/**
 * BridgeSponsor — worker that processes ready sponsor-owned steps on inbound
 * bridges (CCTP + Wormhole).
 *
 * Three step kinds the sponsor acts on:
 *   - "cctp-receive-message"              → Circle `MessageTransmitter.receiveMessage` (Solana)
 *   - "wormhole-complete-transfer-wrapped" → Wormhole `complete_transfer_wrapped` (Solana)
 *   - "settle-inbound-bridge-sponsored"    → the Rome EVM `settle_inbound_bridge` (Solana)
 *
 * For each ready step, the worker:
 *   1. Resolves any pre-flight gates (e.g. OwnerInfo mint-match for settle).
 *   2. Builds + signs + sends the Solana ix via an injected hook.
 *   3. POSTs the resulting signature back to the bridge API.
 *
 * The actual Solana ix construction lives behind injectable hooks
 * (`buildAndSendReceiveMessage` / `buildAndSendCompleteTransfer` /
 * `buildAndSendSettle`) so tests can stub them; production wiring is in
 * `run.ts`.
 */

import type { Keypair, Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { settleAfterReceive, type SettleStepInput } from "./settle-after-receive.js";
import { withTimeout } from "../lib/fetch-timeout.js";

export interface SendReceiveMessageInput {
  /** Raw CCTP message bytes as 0x-hex. */
  message: `0x${string}`;
  /** Circle IRIS attestation bytes as 0x-hex. */
  attestation: `0x${string}`;
  /** Per-chain Solana program / mint ids needed to build receive_message. */
  programs: {
    messageTransmitterProgram: string;
    tokenMessengerMinterProgram: string;
    splTokenProgram: string;
    usdcMint: string;
  };
  /** Pre-derived recipient ATA (matches the CCTP message's mintRecipient field). */
  recipientAta: string;
  /**
   * Owner of the recipient ATA — the user's `external_auth(user, programId)`
   * PDA on the destination rome-evm program. Required because Circle's
   * `MessageTransmitter.receiveMessage` mints USDC to the ATA but does not
   * auto-create it; first-time bridge users fail with InvalidAccountData
   * otherwise. Same gap shape as Wormhole's complete_transfer_wrapped.
   */
  recipientPdaOwner: string;
  /** Record-stamped CCTP version — picks the V1 vs V2 receive builder in run.ts. */
  cctpVersion?: 1 | 2;
  signer: Keypair;
}

export interface SendEnsureAtaInput {
  recipientAta: string;
  recipientPdaOwner: string;
  mint: string;
  splTokenProgram: string;
  signer: Keypair;
}

export interface SendCompleteTransferInput {
  /** Wormhole VAA bytes as 0x-hex. */
  vaa: `0x${string}`;
  /** Per-chain Solana program / mint ids needed to build complete_transfer_wrapped. */
  programs: {
    /** Wormhole Core Bridge program id (signed-VAA verifier). */
    coreBridgeProgram: string;
    /** Wormhole Token Bridge program id (consumes the verified VAA, mints wrapped SPL). */
    tokenBridgeProgram: string;
    /** SPL Token program id (classic or Token-2022). */
    splTokenProgram: string;
    /** The wormhole-wrapped SPL mint that the VAA's payload says will be minted. */
    wrappedMint: string;
  };
  /** Pre-derived recipient ATA (matches the VAA's `to` field). */
  recipientAta: string;
  /**
   * Owner of the recipient ATA — the user's `external_auth(user, programId)`
   * PDA on the destination rome-evm program. Required because Wormhole's
   * `complete_transfer_wrapped` does not auto-create the recipient ATA;
   * first-time bridge users fail with InvalidAccountData otherwise.
   */
  recipientPdaOwner: string;
  signer: Keypair;
}

export interface SendSettleInput {
  chainId: string;                  // bigint as decimal string
  user: `0x${string}`;              // 20-byte EVM addr
  bridgedAmount: string;            // bigint as decimal string, mint base units
  sourceChain: string;              // bigint as decimal string
  sourceTxHash: `0x${string}`;      // 32-byte source-chain tx hash
  rollupProgramId: string;          // base58
  mintAddress: string;              // base58 — the chain's gas mint
  signer: Keypair;
}

export interface GetMintForChain {
  (romeChainId: bigint, rollupProgramId: PublicKey): Promise<PublicKey | null>;
}

export interface SendSettleV2Input extends SendSettleInput {
  deadline: number;
  sourceEvmChainId: string;
  sigR: Uint8Array;
  sigS: Uint8Array;
  sigV: number;
}

/** The user's settle authorization, fetched from the API's token-gated internal endpoint. */
export interface SettleMaterial {
  userSettleSig: string;      // 0x-hex 65B (decrypted server-side)
  deadline: number;
  sourceEvmChainId: string;
}
export interface GetSettleMaterial {
  (transferId: string): Promise<SettleMaterial | null>;
}

export interface SponsorOpts {
  bridgeApiUrl: string;
  sponsorKeypair: Keypair;
  solanaConnection: Connection;
  fetch?: typeof fetch;
  /** Stub-able hook; production wires Task 4's buildReceiveMessageInstruction + send. */
  buildAndSendReceiveMessage?: (input: SendReceiveMessageInput) => Promise<string>;
  /**
   * Stub-able hook for the Wormhole inbound completion step. Production wires
   * a `complete_transfer_wrapped` instruction builder against the Solana
   * Wormhole Token Bridge program. Same shape as the CCTP hook: build, sign
   * with the sponsor keypair, send, return the Solana tx signature.
   */
  buildAndSendCompleteTransfer?: (input: SendCompleteTransferInput) => Promise<string>;
  /** Stub-able hook; production wires Task 5's buildSettleInboundBridgeInstruction + send. */
  buildAndSendSettle?: (input: SendSettleInput) => Promise<string>;
  /** Trustless v2 settle: user-signed authorization + fee-payer, no bridge_settler_key. */
  buildAndSendSettleV2?: (input: SendSettleV2Input) => Promise<string>;
  /** Fetches the user's settle authorization from the API's internal endpoint. */
  getSettleMaterial?: GetSettleMaterial;
  /** Idempotent ATA create preceding a V2 receive (its own tx — size limit). */
  buildAndSendEnsureAta?: (input: SendEnsureAtaInput) => Promise<string>;
  /**
   * Resolves the chain's actual gas mint via on-chain OwnerInfo (Task 3).
   * The sponsor gates settle on `onchain mint == step.mintAddress`.
   */
  getMintForChain?: GetMintForChain;
}

interface TransferStep {
  n: number;
  kind: string;
  status: string;
  // cctp-receive-message metadata
  message?: `0x${string}`;
  attestation?: `0x${string}`;
  programs?: SendReceiveMessageInput["programs"] | SendCompleteTransferInput["programs"];
  // wormhole-complete-transfer-wrapped metadata
  vaa?: `0x${string}`;
  // shared CCTP receive + Wormhole complete metadata
  recipientAta?: string;
  recipientPdaOwner?: string;
  // settle-inbound-bridge-sponsored metadata
  chainId?: string;
  user?: `0x${string}`;
  bridgedAmount?: string;
  sourceChain?: string;
  sourceTxHash?: `0x${string}`;
  rollupProgramId?: string;
  mintAddress?: string;
}

interface TransferRecord {
  id: string;
  outcome: string;
  steps: TransferStep[];
  stamp?: { cctpVersion?: 1 | 2 };
}

export interface TickResult {
  acted: boolean;
  reason?: string;
}

export class BridgeSponsor {
  private fetchFn: typeof fetch;

  constructor(private opts: SponsorOpts) {
    this.fetchFn = withTimeout(opts.fetch ?? globalThis.fetch, 10_000);
  }

  async tickOnce(transferId: string): Promise<TickResult> {
    const record = await this.getTransfer(transferId);
    if (!record) return { acted: false, reason: "transfer GET failed" };
    if (record.outcome !== "pending") return { acted: false, reason: "outcome not pending" };

    for (const step of record.steps) {
      if (step.status !== "ready") continue;

      if (step.kind === "ensure-ata") {
        return this.handleEnsureAta(transferId, step);
      }
      if (step.kind === "cctp-receive-message") {
        return this.handleReceiveMessage(transferId, step, record.stamp?.cctpVersion);
      }
      if (step.kind === "wormhole-complete-transfer-wrapped") {
        return this.handleCompleteTransfer(transferId, step);
      }
      if (step.kind === "settle-inbound-bridge-sponsored") {
        return this.handleSettle(transferId, step);
      }
      // Step kind not owned by sponsor — keep walking.
    }
    return { acted: false, reason: "no ready sponsor step" };
  }

  /**
   * V2 receive is its own tx (1338B > 1232B with an inline ATA create), so the
   * idempotent ATA create precedes it as an explicit step. Same binding rule
   * as receive: recipientAta/owner are route-builder-stamped, never re-derived.
   */
  private async handleEnsureAta(transferId: string, step: TransferStep): Promise<TickResult> {
    if (!this.opts.buildAndSendEnsureAta) {
      return { acted: false, reason: "buildAndSendEnsureAta not wired" };
    }
    if (!step.recipientAta || !step.recipientPdaOwner) {
      return { acted: false, reason: "ensure-ata step missing recipientAta/recipientPdaOwner" };
    }
    const mint = (step.programs as { usdcMint?: string } | undefined)?.usdcMint;
    if (!mint) return { acted: false, reason: "ensure-ata step missing programs.usdcMint" };
    const signature = await this.opts.buildAndSendEnsureAta({
      recipientAta: step.recipientAta,
      recipientPdaOwner: step.recipientPdaOwner,
      mint,
      splTokenProgram: (step.programs as { splTokenProgram?: string } | undefined)?.splTokenProgram ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      signer: this.opts.sponsorKeypair,
    });
    await this.postStep(transferId, step.n, signature);
    return { acted: true };
  }

  private async handleReceiveMessage(transferId: string, step: TransferStep, cctpVersion?: 1 | 2): Promise<TickResult> {
    if (!this.opts.buildAndSendReceiveMessage) {
      return { acted: false, reason: "buildAndSendReceiveMessage not wired" };
    }
    if (!step.message || !step.attestation || !step.programs) {
      return { acted: false, reason: "receive-message step missing message/attestation/programs metadata" };
    }
    // recipientAta + recipientPdaOwner are bound by source-tx verification at
    // POST /v1/transfers (verifyEvmTxMatchesQuote — the mintRecipient bytes32
    // in the depositForBurn calldata equals the route-builder's derivation).
    // Never recompute these inside the sponsor: re-deriving from chain config
    // would let drift between the verified destination and the sponsor's chosen
    // destination weaken the binding invariant. See "Settle gate — intentional
    // asymmetry vs the Rome app" for the full rationale.
    if (!step.recipientAta || !step.recipientPdaOwner) {
      return { acted: false, reason: "receive-message step missing recipientAta/recipientPdaOwner — required so ATA is pre-created" };
    }
    const signature = await this.opts.buildAndSendReceiveMessage({
      message: step.message,
      attestation: step.attestation,
      programs: step.programs as SendReceiveMessageInput["programs"],
      recipientAta: step.recipientAta,
      recipientPdaOwner: step.recipientPdaOwner,
      ...(cctpVersion ? { cctpVersion } : {}),
      signer: this.opts.sponsorKeypair,
    });
    await this.postStep(transferId, step.n, signature);
    return { acted: true };
  }

  private async handleCompleteTransfer(transferId: string, step: TransferStep): Promise<TickResult> {
    if (!this.opts.buildAndSendCompleteTransfer) {
      return { acted: false, reason: "buildAndSendCompleteTransfer not wired" };
    }
    if (!step.vaa || !step.programs) {
      return { acted: false, reason: "complete-transfer step missing vaa/programs metadata" };
    }
    // Same binding invariant as handleReceiveMessage above: recipientAta +
    // recipientPdaOwner are stamped by the route-builder, bound by source-tx
    // verification, and must not be recomputed here.
    if (!step.recipientAta || !step.recipientPdaOwner) {
      return { acted: false, reason: "complete-transfer step missing recipientAta/recipientPdaOwner — required so ATA is pre-created" };
    }
    const signature = await this.opts.buildAndSendCompleteTransfer({
      vaa: step.vaa,
      programs: step.programs as SendCompleteTransferInput["programs"],
      recipientAta: step.recipientAta,
      recipientPdaOwner: step.recipientPdaOwner,
      signer: this.opts.sponsorKeypair,
    });
    await this.postStep(transferId, step.n, signature);
    return { acted: true };
  }

  private async handleSettle(transferId: string, step: TransferStep): Promise<TickResult> {
    // At least one settle path must be wired. Trustless (v2) deployments wire
    // only buildAndSendSettleV2 + getSettleMaterial (no bridge_settler_key).
    if (!this.opts.buildAndSendSettle && !this.opts.buildAndSendSettleV2) {
      return { acted: false, reason: "no settle path wired (need buildAndSendSettle or buildAndSendSettleV2)" };
    }
    const required: (keyof TransferStep)[] = [
      "chainId", "user", "bridgedAmount", "sourceChain",
      "sourceTxHash", "rollupProgramId", "mintAddress",
    ];
    for (const k of required) {
      if (!step[k]) return { acted: false, reason: `settle step missing ${k}` };
    }

    const stepInput: SettleStepInput = {
      chainId:        step.chainId!,
      user:           step.user!,
      bridgedAmount:  step.bridgedAmount!,
      sourceChain:    step.sourceChain!,
      sourceTxHash:   step.sourceTxHash!,
      rollupProgramId: step.rollupProgramId!,
      mintAddress:    step.mintAddress!,
    };

    // ── Trustless v2 path ──
    // If the user signed a settle authorization, use it: any caller may
    // submit, the on-chain program recovers the signer. The fee-payer here
    // (sponsorKeypair) is NOT an authority — its compromise can't settle
    // maliciously. bridge_settler_key never enters this path.
    const material = this.opts.getSettleMaterial ? await this.opts.getSettleMaterial(transferId) : null;
    if (material && this.opts.buildAndSendSettleV2) {
      // An expired authorization is a PERMANENT on-chain
      // rejection (the program returns SignatureExpired). Detect it here and
      // TERMINATE the record — otherwise the worker retry-storms a settle that
      // can never land and the record stalls "pending" forever. Other permanent
      // rejections (high-s, wrong-signer) are rejected upstream at POST
      // /transfers; anything left is bounded by this deadline.
      const nowSec = Math.floor(Date.now() / 1000);
      if (material.deadline <= nowSec) {
        await this.postSkip(transferId, step.n, "settle-expired", `settle authorization expired (deadline ${material.deadline} ≤ now ${nowSec}); re-bridge to retry`);
        await this.postPurgeSettleMaterial(transferId);
        return { acted: true, reason: "settle authorization expired" };
      }
      const resultV2 = await settleAfterReceive({
        step: stepInput,
        signer: this.opts.sponsorKeypair,
        buildAndSendSettle: async () => {
          const sig = material.userSettleSig.startsWith("0x") ? material.userSettleSig.slice(2) : material.userSettleSig;
          return this.opts.buildAndSendSettleV2!({
            ...stepInput,
            signer: this.opts.sponsorKeypair,
            deadline: material.deadline,
            sourceEvmChainId: material.sourceEvmChainId,
            sigR: Uint8Array.from(Buffer.from(sig.slice(0, 64), "hex")),
            sigS: Uint8Array.from(Buffer.from(sig.slice(64, 128), "hex")),
            sigV: parseInt(sig.slice(128, 130), 16),
          });
        },
        ...(this.opts.getMintForChain ? { getMintForChain: this.opts.getMintForChain } : {}),
      });
      if (resultV2.outcome === "wrapper-only") {
        await this.postSkip(transferId, step.n, "settle-skipped", resultV2.reason);
        return { acted: true, ...(resultV2.reason !== undefined ? { reason: resultV2.reason } : {}) };
      }
      if (resultV2.outcome !== "all-gas") {
        return { acted: false, ...(resultV2.reason !== undefined ? { reason: resultV2.reason } : {}) };
      }
      await this.postStep(transferId, step.n, resultV2.settleTxHash!);
      // Purge the one-time authorization now that settle is submitted.
      await this.postPurgeSettleMaterial(transferId);
      return { acted: true };
    }

    // ── Legacy v1 path (bridge_settler_key) — kept for in-flight/legacy drain ──
    if (!this.opts.buildAndSendSettle) {
      // v2-only deployment with a record that carries no authorization —
      // can't settle it (shouldn't happen; new records always carry a sig).
      return { acted: false, reason: "no settle authorization and no v1 settle path wired" };
    }
    const result = await settleAfterReceive({
      step: stepInput,
      signer: this.opts.sponsorKeypair,
      buildAndSendSettle: this.opts.buildAndSendSettle,
      ...(this.opts.getMintForChain ? { getMintForChain: this.opts.getMintForChain } : {}),
    });

    if (result.outcome === "wrapper-only") {
      // Terminal: the OwnerInfo gate refused (bridged asset isn't this chain's
      // gas mint) — no retry will change it. Report the skip so the record
      // completes honestly (outcome complete + degradation settle-skipped)
      // instead of stalling pending forever.
      await this.postSkip(transferId, step.n, "settle-skipped", result.reason);
      return { acted: true, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
    }
    if (result.outcome !== "all-gas") {
      // settle-skipped = transient hook failure (rpc, unwired) — retry next tick.
      return { acted: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
    }

    await this.postStep(transferId, step.n, result.settleTxHash!);
    return { acted: true };
  }

  private async getTransfer(transferId: string): Promise<TransferRecord | null> {
    const res = await this.fetchFn(`${this.opts.bridgeApiUrl}/v1/transfers/${transferId}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as TransferRecord;
  }

  private async postPurgeSettleMaterial(transferId: string): Promise<void> {
    await this.fetchFn(`${this.opts.bridgeApiUrl}/v1/transfers/${transferId}/settle-material`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ purgeSettleMaterial: true }),
    });
  }

  private async postSkip(transferId: string, n: number, degradation: string, reason?: string): Promise<void> {
    await this.fetchFn(`${this.opts.bridgeApiUrl}/v1/transfers/${transferId}/steps/${n}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ skip: { degradation, ...(reason ? { reason } : {}) } }),
    });
  }

  private async postStep(transferId: string, n: number, txHash: string): Promise<void> {
    await this.fetchFn(`${this.opts.bridgeApiUrl}/v1/transfers/${transferId}/steps/${n}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ txHash, broadcastAt: new Date().toISOString() }),
    });
  }
}
