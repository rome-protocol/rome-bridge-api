/**
 * run.ts — Bridge sponsor worker entrypoint.
 *
 * This process is intentionally SEPARATE from the bridge API. It holds the
 * sponsor Solana keypair; the API process never does.
 *
 * v1.0.1 wiring:
 *   - `buildAndSendReceiveMessage` uses Task 4's `buildReceiveMessageInstruction`
 *     to assemble Circle's `MessageTransmitter.receiveMessage` ix, signs with the
 *     loaded sponsor keypair, and submits via Solana RPC.
 *   - `buildAndSendCompleteTransfer` uses
 *     `buildCompleteTransferWrappedInstruction` to assemble Wormhole Token
 *     Bridge's `complete_transfer_wrapped` ix from a guardian-signed VAA.
 *   - `buildAndSendSettle` uses Task 5's `buildSettleInboundBridgeInstruction` to
 *     call the Rome EVM's settle_inbound_bridge.
 *   - `getMintForChain` uses Task 3's `OwnerInfoClient` so the sponsor performs
 *     the OwnerInfo mint-match gate on-chain against the rome-evm program.
 *
 * v1.0.1 limitations (deferred to v1.1+):
 *   - The polling loop still iterates ticks on a fixed cadence; the full
 *     "scan for ready transfers" path (GET /v1/transfers?address=...) lands
 *     when the list-transfers endpoint is added.
 */
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { hexToBytes } from "viem";
import {
  BridgeSponsor,
  type SendReceiveMessageInput,
  type SendCompleteTransferInput,
  type SendSettleInput,
} from "./bridge-sponsor.js";
import { makeSponsorHooks, defaultSignAndSend } from "./hooks.js";
import { drivePending } from "./drive.js";
import { buildSettleInboundBridgeInstruction } from "../cctp/solana-settle.js";
import { buildSettleInboundBridgeV2Instruction } from "../cctp/solana-settle-v2.js";
import { withTimeout } from "../lib/fetch-timeout.js";
import { requireEnv } from "../lib/required-env.js";
import { executeWormholeReceiveFlow } from "../wormhole/execute-receive-flow.js";
import { decodeVaa } from "../wormhole/decode-vaa.js";
import { OwnerInfoClient } from "../chains/owner-info-reader.js";

const BRIDGE_API_URL = process.env.BRIDGE_API_URL ?? "http://localhost:3000";
const SPONSOR_KEYPAIR_PATH = process.env.SPONSOR_KEYPAIR_PATH;
// Trustless settle: the worker holds this ONLY to read the encrypted
// authorization + purge it — it is NOT an on-chain authority.
const WORKER_INTERNAL_TOKEN = process.env.WORKER_INTERNAL_TOKEN;

if (!SPONSOR_KEYPAIR_PATH) {
  console.error("[sponsor] SPONSOR_KEYPAIR_PATH env var required");
  process.exit(1);
}
// Fail-closed: never default to the public rate-limited devnet endpoint — a
// flaky public RPC presents as a broken bridge (every sponsor tx intermittent).
let SOLANA_RPC_URL: string;
try {
  SOLANA_RPC_URL = requireEnv("SOLANA_RPC_URL");
} catch (err) {
  console.error(`[sponsor] ${(err as Error).message}`);
  process.exit(1);
}

const sponsorKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(SPONSOR_KEYPAIR_PATH, "utf8"))),
);
// Timeout-bounded transport: web3.js RPC calls carry no timeout of their own —
// one hung socket would wedge the drive loop's no-overlap guard forever.
const solanaConnection = new Connection(SOLANA_RPC_URL, {
  commitment: "confirmed",
  fetch: withTimeout(globalThis.fetch, 20_000) as never,
});
const ownerInfoClient = new OwnerInfoClient({ connection: solanaConnection });

// All sponsor txs (receive, ensure-ata, settle) send via hooks.defaultSignAndSend —
// a legacy tx that honors computeBudget:false. The CCTP V2 receive passes
// computeBudget:false (its ~181K CU fits the 200K default), which omits the
// ComputeBudget ix so it fits the 1232B cap with no ALT needed (verified on-chain).

// V1/V2 receive + ensure-ata wiring lives in the injectable factory so the
// funded E2E harness runs EXACTLY this code path (src/sponsor/hooks.ts).
const cctpHooks = makeSponsorHooks({ connection: solanaConnection });
const buildAndSendReceiveMessage = cctpHooks.buildAndSendReceiveMessage;
const buildAndSendEnsureAta = cctpHooks.buildAndSendEnsureAta;

async function buildAndSendSettle(input: SendSettleInput): Promise<string> {
  const ix = buildSettleInboundBridgeInstruction({
    chainId: BigInt(input.chainId),
    signer: input.signer.publicKey,
    user: hexToBytes(input.user),
    bridgedAmount: BigInt(input.bridgedAmount),
    sourceChain: BigInt(input.sourceChain),
    sourceTxHash: hexToBytes(input.sourceTxHash),
    rollupProgramId: new PublicKey(input.rollupProgramId),
    mintAddress: new PublicKey(input.mintAddress),
  });
  return defaultSignAndSend(solanaConnection, input.signer, [ix]);
}

async function buildAndSendCompleteTransfer(input: SendCompleteTransferInput): Promise<string> {
  // Runs the full 3-stage Wormhole receive: verifySignatures →
  // postVaa → createATA-idempotent + completeTransferWrapped. The
  // single-ix path (buildCompleteTransferWrappedInstruction alone) fails
  // with InvalidAccountData when the recipient ATA doesn't exist or with
  // "Not enough bytes" when the VAA isn't yet posted on-chain.
  return executeWormholeReceiveFlow({
    connection: solanaConnection,
    payer: input.signer,
    vaaBytes: decodeVaa(input.vaa),
    tokenBridgePid:   new PublicKey(input.programs.tokenBridgeProgram),
    wormholeCorePid:  new PublicKey(input.programs.coreBridgeProgram),
    splTokenProgram:  new PublicKey(input.programs.splTokenProgram),
    wrappedMint:      new PublicKey(input.programs.wrappedMint),
    recipientAta:     new PublicKey(input.recipientAta),
    recipientPdaOwner: new PublicKey(input.recipientPdaOwner),
  });
}

async function buildAndSendSettleV2(input: import("./bridge-sponsor.js").SendSettleV2Input): Promise<string> {
  const ix = buildSettleInboundBridgeV2Instruction({
    chainId: BigInt(input.chainId),
    submitter: input.signer.publicKey, // fee-payer only — NOT an authority
    user: hexToBytes(input.user),
    bridgedAmount: BigInt(input.bridgedAmount),
    sourceChain: BigInt(input.sourceChain),
    sourceTxHash: hexToBytes(input.sourceTxHash),
    deadline: BigInt(input.deadline),
    sourceEvmChainId: BigInt(input.sourceEvmChainId),
    sigR: input.sigR,
    sigS: input.sigS,
    sigV: input.sigV,
    rollupProgramId: new PublicKey(input.rollupProgramId),
    mintAddress: new PublicKey(input.mintAddress),
  });
  return defaultSignAndSend(solanaConnection, input.signer, [ix]);
}

/** Fetch the decrypted settle authorization from the API's token-gated internal endpoint. */
async function getSettleMaterial(transferId: string) {
  if (!WORKER_INTERNAL_TOKEN) return null; // trustless settle disabled
  const res = await withTimeout(globalThis.fetch, 10_000)(
    `${BRIDGE_API_URL}/v1/transfers/${transferId}/settle-material`,
    { headers: { "x-worker-token": WORKER_INTERNAL_TOKEN, accept: "application/json" } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`settle-material fetch ${res.status}`);
  const body = (await res.json()) as { userSettleSig?: string; deadline?: number; sourceEvmChainId?: string };
  if (!body.userSettleSig || body.deadline === undefined || !body.sourceEvmChainId) return null;
  return { userSettleSig: body.userSettleSig, deadline: body.deadline, sourceEvmChainId: body.sourceEvmChainId };
}

const worker = new BridgeSponsor({
  bridgeApiUrl: BRIDGE_API_URL,
  sponsorKeypair,
  solanaConnection,
  buildAndSendReceiveMessage,
  buildAndSendEnsureAta,
  buildAndSendCompleteTransfer,
  buildAndSendSettle,
  buildAndSendSettleV2,
  getSettleMaterial,
  getMintForChain: (chainId, programId) => ownerInfoClient.getMintForChain(programId, chainId),
});

console.log(
  `[sponsor] worker started. bridgeApi=${BRIDGE_API_URL} rpc=${SOLANA_RPC_URL} ` +
  `payer=${sponsorKeypair.publicKey.toBase58()}`,
);

// Drive loop: poll the token-gated pending list and tickOnce each transfer. One
// ready step advances per tick; successive passes walk ensure-ata → receive →
// settle as the API's attestation poller marks each next step ready.
async function listPendingIds(): Promise<string[]> {
  if (!WORKER_INTERNAL_TOKEN) return []; // /transfers/pending is token-gated; no token ⇒ idle
  const res = await withTimeout(globalThis.fetch, 10_000)(
    `${BRIDGE_API_URL}/v1/transfers/pending`,
    { headers: { "x-worker-token": WORKER_INTERNAL_TOKEN, accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`pending list fetch ${res.status}`);
  const body = (await res.json()) as { ids?: string[] };
  return body.ids ?? [];
}

// Heartbeat: report every pass (even idle ones) so /v1/health surfaces real
// worker liveness — a server whose worker is absent or wedged must read degraded,
// not ok. Fire-and-forget: a failed report never blocks the next pass.
async function postHeartbeat(stats: { processed: number; acted: number; durationMs: number }): Promise<void> {
  if (!WORKER_INTERNAL_TOKEN) return;
  try {
    // Sponsor balance rides every heartbeat (T2#9): a draining fee-payer
    // degrades /health BEFORE transfers start stalling. Best-effort — a
    // failed read just omits the field (health then skips the verdict).
    let sponsorLamports: number | undefined;
    try {
      sponsorLamports = await solanaConnection.getBalance(sponsorKeypair.publicKey, "confirmed");
    } catch {
      /* omit on read failure */
    }
    await withTimeout(globalThis.fetch, 10_000)(`${BRIDGE_API_URL}/v1/worker/heartbeat`, {
      method: "POST",
      headers: { "x-worker-token": WORKER_INTERNAL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ ...stats, ...(sponsorLamports !== undefined ? { sponsorLamports } : {}) }),
    });
  } catch (err) {
    console.warn(`[sponsor] heartbeat post failed: ${(err as Error).message}`);
  }
}

const TICK_TIMEOUT_MS = Number(process.env.SPONSOR_TICK_TIMEOUT_MS ?? 90_000);

let driving = false;
setInterval(() => {
  if (driving) return; // never overlap a slow pass (per-tick timeout keeps passes finite)
  driving = true;
  drivePending({ listPendingIds, tickOnce: (id) => worker.tickOnce(id), tickTimeoutMs: TICK_TIMEOUT_MS })
    .then(async (r) => {
      if (r.processed) console.log(`[sponsor] drove ${r.processed} pending, acted ${r.acted} in ${r.durationMs}ms`);
      await postHeartbeat(r);
    })
    .catch((err) => console.error(`[sponsor] drive pass failed: ${(err as Error).message}`))
    .finally(() => { driving = false; });
}, 5_000);

export { worker };
