/**
 * Served OpenAPI document (the API publishes its own
 * contract; a CI conformance test asserts every registered route literal is
 * documented). Shapes reference docs/API.md; schema fidelity deepens as the
 * generated-SDK pipeline lands.
 */
import { FastifyInstance } from "fastify";
import packageJson from "../../package.json" with { type: "json" };

const problemJson = { description: "RFC 9457 application/problem+json with a rome.bridge.* code" };
const transferRecord = { description: "Transfer record: steps[], outcome, stamp, degradation, sponsor attribution" };

export const OPENAPI_DOC = {
  openapi: "3.1.0",
  info: {
    title: "Rome Bridge API",
    version: packageJson.version,
    description:
      "Chain-agnostic bridge surface for Rome chains. CCTP V2-native with per-record V1 drain; any registry-cataloged EVM source. Errors are RFC 9457 problem+json; chain identity dual-accepts legacy symbolic rails and CAIP-2 during the Sunset window.\n\n" +
      "## Trust model\n" +
      "This service is an off-chain orchestrator, not a custodian: it holds no signing keys and can never move user funds. Quotes return UNSIGNED transactions — you sign them in your own wallet. The sponsor worker is fee-payer-only and can credit, never debit: it invokes permissionless completion primitives whose destinations are locked by your source-side transaction. Destinations are derived from your identity (PDA derivation from your address), never from caller-supplied fields. Registration verifies your source transaction on-chain with equality-only matching (to, selector, full calldata, value). Gas settlement is authorized by YOUR EIP-712 signature bound to your burn hash — any party may submit it, but the on-chain program is the final gate and rejects anything you did not sign for. An asset settles as native gas only when its mint IS the chain's on-chain gas mint; otherwise it is delivered as the canonical wrapper token and the record says so explicitly (degradation field).\n\n" +
      "## Versioning\n" +
      "The /v1 URL prefix is the API namespace (this service's REST contract version). It is unrelated to Circle CCTP protocol versions: every route/quote/record carries an explicit cctpVersion (2 today; CCTP v1 is retired — rome.bridge.v1-phased-out).",
  },
  servers: [{ url: "/v1" }],
  paths: {
    "/health": { get: { summary: "Liveness + attestation upstream health", responses: { "200": { description: "ok" } } } },
    "/chains": { get: { summary: "Rome chains served by this API (registry-resolved)", responses: { "200": { description: "chains[]" } } } },
    "/chains/{chainId}": { get: { summary: "One Rome chain by id", responses: { "200": { description: "chain" }, "404": problemJson } } },
    "/assets": { get: { summary: "Legacy route matrix (alias — prefer /routes)", responses: { "200": { description: "routes[]" } } } },
    "/tokens": { get: { summary: "Mint-keyed token catalog for a chain (registry-verified ∪ on-chain factory long-tail)", responses: { "200": { description: "{ chainId, tokens[] }" }, "400": problemJson } } },
    "/routes": {
      get: {
        summary: "Capability matrix with live per-route status; each row carries its explicit cctpVersion",
        description: "Per {asset, sourceChainId (CAIP-2), direction, romeChainId}: limits, speeds (fast = live Circle fees probe), fees, eta, status active|degraded|paused (+statusDetail).",
        responses: { "200": { description: "routes[] with live status" } },
      },
    },
    "/quote": {
      post: {
        summary: "Quote a bridge route (unsigned txs + step plan)",
        description:
          "sourceChain dual-accepts symbolic|CAIP-2 (Sunset header on symbolic); sourceChainId selects a catalog source; speed standard|fast (fast fails closed to standard); simulate:true adds per-tx eth_call preflight. Response: steps[] (chainRef/chainName/sponsor per step), cctpVersion, sourceChainRef, protocolFee '0', fees[], etaSeconds, etaP90Seconds.",
        responses: { "200": { description: "quote" }, "400": problemJson, "410": problemJson },
      },
    },
    "/transfers": {
      post: {
        summary: "Register a transfer after step-1 broadcast (verifies the burn on-chain)",
        description: "Equality-only verification against the record's registry stamp via the source chain's own client. Idempotent on (chain, step1TxHash) + optional Idempotency-Key header.",
        responses: { "200": transferRecord, "400": problemJson, "404": problemJson },
      },
      get: { summary: "Transfer history by address", responses: { "200": { description: "transfers[]" }, "400": problemJson } },
    },
    "/transfers/pending": {
      get: {
        summary: "Internal (worker-only): ids of all pending transfers",
        description: "Token-gated (x-worker-token). The co-deployed sponsor worker polls this to drive tickOnce on each pending transfer until its steps settle. 404 without the token.",
        "x-internal": true,
        responses: { "200": { description: "{ ids: string[] }" }, "404": problemJson },
      },
    },
    "/worker/heartbeat": {
      post: {
        summary: "Internal (worker-only): report a drive pass for /health liveness",
        description: "Token-gated (x-worker-token). The sponsor worker POSTs {processed, acted, durationMs} after every drive pass; /health surfaces the heartbeat age and degrades overall status when a configured worker is missing or stale. 404 without the token.",
        "x-internal": true,
        responses: { "200": { description: "{ ok: true }" }, "400": { description: "invalid heartbeat stats" }, "404": problemJson },
      },
    },
    "/transfers/{id}": { get: { summary: "Full transfer state", responses: { "200": transferRecord, "404": problemJson } } },
    "/transfers/{id}/events": {
      get: {
        summary: "SSE status push with Last-Event-ID resume",
        responses: { "200": { description: "text/event-stream — events: created|step|outcome|degradation, id = seq" }, "404": problemJson },
      },
    },
    "/transfers/{id}/settle-material": {
      get: {
        summary: "Internal (worker-only): decrypted settle authorization",
        description: "Token-gated (x-worker-token). The co-deployed trustless worker fetches the user's decrypted EIP-712 settle signature here; never exposed on the public transfer read. 404 without the token.",
        responses: { "200": { description: "settle material" }, "404": problemJson },
      },
      post: {
        summary: "Internal (worker-only): purge the settle authorization",
        description: "Token-gated. Called once settle is submitted to purge the one-time signature.",
        responses: { "200": { description: "purged" }, "404": problemJson },
      },
    },
    "/transfers/{id}/steps/{n}": {
      post: {
        summary: "Report a step's broadcast tx hash (or a terminal sponsor skip)",
        description: "Body { txHash } for broadcasts; { skip: { degradation, reason? } } (settle steps only) completes the record with a degradation qualifier — outcome enum unchanged.",
        responses: { "200": transferRecord, "400": problemJson, "404": problemJson, "409": problemJson },
      },
    },
    "/solana/latest-blockhash": { get: { summary: "Fresh Solana blockhash for same-origin browser clients", responses: { "200": { description: "{ blockhash, lastValidBlockHeight }" }, "503": problemJson } } },
    "/solana/tx": { get: { summary: "Confirmation status for a submitted Solana deposit signature (status: unknown|processed|confirmed|finalized; on-chain failure rides through as err)", responses: { "200": { description: "{ signature, status, err, slot }" }, "400": problemJson, "503": problemJson } } },
    "/openapi.json": { get: { summary: "This document", responses: { "200": { description: "OpenAPI 3.1" } } } },
  },
} as const;

export async function openapiRoutes(app: FastifyInstance) {
  app.get("/openapi.json", async () => OPENAPI_DOC);
}
