import { TransferStore } from "../transfers/store.js";
import type { AttestationHealth } from "../routes/routes-matrix.js";
import { CircleAttestationClient } from "./circle.js";
import { CircleV2AttestationClient } from "./circle-v2.js";
import { WormholeAttestationClient } from "./wormhole.js";
import { parseLogMessagePublished, type LogLike } from "../wormhole/parse-log-message-published.js";
import { parseSepoliaCctpMessage } from "../cctp/sepolia-message-parse.js";
import { encodeFunctionData, parseAbi } from "viem";
import { attestationPollerLagSeconds } from "../observability/metrics.js";

export type TxLogReader = (txHash: string) => Promise<readonly LogLike[]>;
/** Rome proxy extension rome_solanaTxForEvmTx: Rome EVM tx hash → Solana signature(s). */
export type SolanaSigResolver = (romeRpcUrl: string, evmTxHash: string) => Promise<string[]>;

const RECEIVE_MESSAGE_ABI = parseAbi(["function receiveMessage(bytes message, bytes attestation)"]);
const WORMHOLE_CLAIM_ABI = parseAbi([
  "function completeTransfer(bytes encodedVm)",
  "function completeTransferAndUnwrapETH(bytes encodedVm)",
]);

export interface WormholeSourceChainConfig {
  /** Source-chain Token Bridge contract address — the `sender` field of the
   *  Wormhole Core Bridge's `LogMessagePublished` event we filter for. */
  tokenBridgeEmitter: string;
  /** Wormhole's chain id for the source chain (10002 = Sepolia, 2 = Ethereum mainnet). */
  wormholeChainId: number;
}

type Vendor = "circle" | "wormhole";

export class AttestationPoller {
  // Wall-clock epoch-seconds of the last successful attestation fetch per vendor.
  // Drives the `rome_bridge_api_attestation_poller_lag_seconds` gauge so ops
  // can alert on stale upstreams (Circle IRIS / Wormholescan outages). Reset
  // to zero on success; recomputed against `Date.now()` on each tick so the
  // gauge reflects real wall-clock staleness, not just "time since last write".
  private lastFetchedAt: Partial<Record<Vendor, number>> = {};

  constructor(
    private store: TransferStore,
    private circle: CircleAttestationClient,
    private wormhole?: WormholeAttestationClient,
    private txLogReader?: TxLogReader,
    private wormholeSourceChain?: WormholeSourceChainConfig,
    private circleV2: CircleV2AttestationClient = new CircleV2AttestationClient(),
    /** Shared health object (server-owned) that /routes reads for live per-route status. */
    private health?: AttestationHealth,
    private solanaSigResolver?: SolanaSigResolver,
  ) {}

  async tickOnce(transferId: string) {
    const record = await this.store.get(transferId);
    if (!record) return;
    if (record.outcome !== "pending") return;

    const receive = record.steps.find((s) => s.kind === "cctp-receive-message" || s.kind === "wormhole-complete-transfer-wrapped");
    const claim = record.steps.find((s) => s.kind === "cctp-claim-on-destination");
    const whClaim = record.steps.find((s) => s.kind === "wormhole-claim-on-ethereum" || s.kind === "wormhole-claim-on-destination");
    if (receive && receive.status === "blocked") {
      if (receive.kind === "cctp-receive-message") {
        await this.handleCctpInbound(transferId, record, receive.n);
      } else {
        await this.handleWormholeInbound(transferId, record, receive.n);
      }
    } else if (claim && claim.status === "blocked") {
      await this.handleCctpOutbound(transferId, record, claim);
    } else if (whClaim && whClaim.status === "blocked") {
      await this.handleWormholeOutbound(transferId, record, whClaim);
    } else if (!receive && !claim && !whClaim) {
      return;
    }
    // Refresh the lag gauge for any vendor we've ever heard from — this way
    // a vendor that succeeded 10 minutes ago shows up as "10 min stale" at
    // every subsequent tick, not stuck at the value we wrote 10 min ago.
    this.refreshLagGauges();
    // Outbound claim steps (Ethereum-side) are handled separately — out of scope for v1.0 poller.
  }

  /**
   * Record-keyed V1/V2 dispatch: the record's
   * stamp — never live config — picks the iris path, base URL and domain, so
   * in-flight records drain under exactly the transport they were quoted
   * with. Unstamped legacy records read as V1 via the store's backfill.
   */
  private async handleCctpInbound(transferId: string, record: any, receiveN = 2) {
    const step1Hash = record.steps[0]?.txHashes?.[0];
    if (!step1Hash) return;

    if (record.stamp?.cctpVersion === 2) {
      const r = await this.viaVendor("circle", () => this.circleV2.fetchByTxHash(record.stamp.irisBase, record.stamp.cctpDomain, step1Hash));
      if (r.status === "complete" && r.attestation && r.message) {
        // Attestation existing proves the burn mined. If an ensure-ata step
        // precedes the receive, stage it: stash message+attestation on the
        // (still blocked) receive and flip ensure-ata ready — the steps/{n}
        // report unblocks the receive once ensure-ata confirms.
        const ensureAta = record.steps.find((s: { kind: string }) => s.kind === "ensure-ata");
        const ensureDone = !ensureAta || ensureAta.status === "confirmed";
        await this.store.updateStep(transferId, receiveN, {
          ...(ensureDone ? { status: "ready" as const } : {}),
          attestation: r.attestation,
          message: r.message,
          expiresAt: new Date(Date.now() + 90_000).toISOString(),
        });
        if (ensureAta && ensureAta.status === "blocked") {
          await this.store.updateStep(transferId, ensureAta.n, { status: "ready" });
        }
      }
      return;
    }

    // V1 drain path (message hash = step-1 tx hash; iris accepts both formats).
    const r = await this.viaVendor("circle", () => this.circle.fetch(step1Hash));
    if (r.status === "complete" && r.attestation) {
      // The V1 iris response carries only the attestation — the wire message
      // comes from the source tx's MessageSent log. The sponsor's receive
      // needs BOTH; without this the step would sit ready-but-unactionable.
      let message: string | undefined;
      if (this.txLogReader && record.stamp?.cctpMessageTransmitter) {
        try {
          const logs = await this.txLogReader(step1Hash);
          const parsed = parseSepoliaCctpMessage({
            receipt: { status: "success", logs: logs as never },
            messageTransmitter: record.stamp.cctpMessageTransmitter as `0x${string}`,
          });
          message = "0x" + Buffer.from(parsed.message).toString("hex");
        } catch {
          return; // logs not readable yet — retry next tick before marking ready
        }
      }
      await this.store.updateStep(transferId, receiveN, {
        status: "ready",
        attestation: r.attestation,
        ...(message ? { message } : {}),
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
      });
    }
  }

  private async handleWormholeInbound(transferId: string, record: any, receiveN = 2) {
    if (!this.wormhole)          return;  // no Wormholescan client wired
    if (!this.txLogReader)       return;  // no source-chain log reader wired (deploy-time gap)
    if (!this.wormholeSourceChain) return;

    const step1Hash = record.steps[0]?.txHashes?.[0];
    if (!step1Hash) return;

    // 1. Read the source-tx logs and find Wormhole's LogMessagePublished from the expected Token Bridge.
    const logs = await this.txLogReader(step1Hash);
    const decoded = parseLogMessagePublished(logs, this.wormholeSourceChain.tokenBridgeEmitter);
    if (!decoded) return;  // not yet mined, or no LogMessagePublished found — try again next tick.

    // 2. Fetch the signed VAA via Wormholescan.
    const r = await this.viaVendor("wormhole", () => this.wormhole!.fetch(
      this.wormholeSourceChain!.wormholeChainId,
      decoded.emitter,
      decoded.sequence,
      ));
    if (r.status !== "complete" || !r.vaa) return;  // still pending or failed; retry next tick.


    // 3. Advance the receive step → ready with the VAA in its data.
    await this.store.updateStep(transferId, receiveN, {
      status: "ready",
      vaa: r.vaa,
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    });
  }

  /**
   * Outbound (Rome → destination EVM): the CCTP message originates on SOLANA
   * (the Rome burn CPIs Circle's programs), so the leg is: Rome burn tx →
   * rome_solanaTxForEvmTx → iris v2 on the Solana domain → materialize the
   * user-paid receiveMessage claim against the destination's stamped
   * transmitter. Everything keys off the record stamp.
   */
  private async handleCctpOutbound(transferId: string, record: any, claim: any) {
    const romeTx = record.steps[0]?.txHashes?.[0];
    if (!romeTx) return;
    if (!record.stamp?.irisBase || record.stamp.cctpDomain === undefined) return;

    let sigs: string[] | undefined = claim.solanaSigs;
    if (!sigs || sigs.length === 0) {
      if (!this.solanaSigResolver || !record.stamp.romeRpcUrl) return;
      try {
        sigs = await this.solanaSigResolver(record.stamp.romeRpcUrl, romeTx);
      } catch {
        return; // proxy unreachable — retry next tick
      }
      if (!sigs || sigs.length === 0) return;
      await this.store.updateStep(transferId, claim.n, { solanaSigs: sigs });
    }

    for (const sig of sigs) {
      const r = await this.viaVendor("circle", () => this.circleV2.fetchByTxHash(record.stamp.irisBase, record.stamp.cctpDomain, sig));
      if (r.status === "complete" && r.message && r.attestation) {
        if (!claim.claimTransmitter) return; // quote-time invariant; fail closed
        // The attestation proves the burn mined — confirm step 1 (parity with
        // the Wormhole outbound branch; store.updateStep flips the record to
        // outcome: complete only when EVERY step confirms, so without this
        // outbound records could never complete).
        await this.store.updateStep(transferId, 1, { status: "confirmed", confirmedAt: new Date().toISOString() });
        const data = encodeFunctionData({
          abi: RECEIVE_MESSAGE_ABI, functionName: "receiveMessage",
          args: [r.message as `0x${string}`, r.attestation as `0x${string}`],
        });
        // NO expiresAt on the claim: Circle attestations stay valid
        // indefinitely and the claim is user-paced. The old +90s stamp made
        // any client honoring expiresAt treat a claim older than 90 seconds
        // as dead (operator repro 2026-07-09) — and the poller never
        // refreshes a step once it leaves "blocked".
        await this.store.updateStep(transferId, claim.n, {
          status: "ready",
          message: r.message,
          attestation: r.attestation,
          unsignedTxs: [{
            to: claim.claimTransmitter, data, value: "0", estimatedGas: "200000",
            description: `Redeem USDC on destination domain ${claim.claimDomain} via MessageTransmitterV2.receiveMessage`,
          }],
        });
        return;
      }
    }
  }

  /**
   * From-rome Wormhole claim (eth/token-wormhole-from-rome): the burn emits
   * the Wormhole message on SOLANA. Resolve the burn's Solana sig via the
   * registration-stamped Rome RPC, ask wormholescan by txHash, and when the
   * VAA is signed: confirm step 1 (a signed VAA proves the burn mined —
   * mirrors the CCTP attested-step-1 rule) and flip the claim ready with the
   * redeem calldata (builder-stamped claimTokenBridge/claimMethod, arg = the
   * VAA bytes). Without claim metadata the VAA still attaches — portal redeem.
   */
  private async handleWormholeOutbound(transferId: string, record: any, claim: any) {
    if (claim.vaa) return; // already materialized — idempotent ticks
    const burnStep = record.steps.find((s: { n: number }) => s.n === 1);
    const romeTx = burnStep?.txHashes?.at(-1);
    if (!romeTx) return;
    if (!this.wormhole?.fetchByTxHash) return;

    let sigs: string[] | undefined = claim.solanaSigs;
    if (!sigs || sigs.length === 0) {
      if (!this.solanaSigResolver || !claim.romeRpcUrl) return;
      try {
        sigs = await this.solanaSigResolver(claim.romeRpcUrl, romeTx);
      } catch {
        return; // proxy unreachable — retry next tick
      }
      if (!sigs || sigs.length === 0) return;
      await this.store.updateStep(transferId, claim.n, { solanaSigs: sigs });
    }

    for (const sig of sigs) {
      const r = await this.viaVendor("wormhole", () => this.wormhole!.fetchByTxHash(sig));
      if (r.status !== "complete" || !r.vaa) continue;
      // A signed VAA proves the burn mined and finalized.
      await this.store.updateStep(transferId, 1, { status: "confirmed", confirmedAt: new Date().toISOString() });
      const vaaHex = ("0x" + Buffer.from(r.vaa, "base64").toString("hex")) as `0x${string}`;
      const method = claim.claimMethod === "completeTransferAndUnwrapETH" ? "completeTransferAndUnwrapETH" : "completeTransfer";
      await this.store.updateStep(transferId, claim.n, {
        status: "ready",
        vaa: r.vaa,
        ...(claim.claimTokenBridge
          ? {
              unsignedTxs: [{
                to: claim.claimTokenBridge,
                data: encodeFunctionData({ abi: WORMHOLE_CLAIM_ABI, functionName: method, args: [vaaHex] }),
                value: "0", estimatedGas: "350000",
                description: `Redeem the Wormhole VAA on the destination token bridge via ${method}`,
              }],
            }
          : {}),
      });
      return;
    }
  }

  /** Reachability wrapper: ANY completed round-trip (complete/pending/not-found)
   *  proves the upstream is up; only a thrown fetch (network/timeout/5xx) is a
   *  failure. The tick's caller swallows the rethrow into a warn log — the
   *  health mark is how /v1/routes still sees the outage. */
  private async viaVendor<T>(vendor: Vendor, call: () => Promise<T>): Promise<T> {
    try {
      const r = await call();
      this.markVendorSuccess(vendor);
      return r;
    } catch (err) {
      // An HTTP-status throw means the upstream ANSWERED — reachable. Only
      // transport-level failures (network/timeout) may degrade the vendor,
      // matching CircleFeesProbe.onUpstreamResult semantics.
      if ((err as { upstreamAnswered?: boolean }).upstreamAnswered) this.markVendorSuccess(vendor);
      else if (this.health) this.health[vendor].lastFailureAt = Date.now();
      throw err;
    }
  }

  private markVendorSuccess(vendor: Vendor) {
    const now = Date.now() / 1000;
    this.lastFetchedAt[vendor] = now;
    attestationPollerLagSeconds.set({ vendor }, 0);
    if (this.health) this.health[vendor].lastSuccessAt = Date.now();
  }

  private refreshLagGauges() {
    const now = Date.now() / 1000;
    for (const [vendor, ts] of Object.entries(this.lastFetchedAt)) {
      if (ts !== undefined) {
        attestationPollerLagSeconds.set({ vendor }, now - ts);
      }
    }
  }
}
