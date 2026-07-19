import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Config } from "../config.js";
import { TransferStore } from "../transfers/store.js";
import { bridgeError } from "../errors.js";
import { verifyEvmTxMatchesQuote } from "../transfers/verify.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { stampFromChainConfig } from "../transfers/stamp.js";
import { verifyAgainstTypedData } from "../cctp/settle-auth.js";
import { rowCipherFromEnv } from "../lib/row-crypto.js";
import { workerAuthorized } from "../lib/worker-auth.js";
import { entryFor } from "../registry/catalog.js";
import { liveContractAddress } from "../registry/contracts.js";
import type { RecordStampT } from "../transfers/types.js";

const PostBody = z.object({
  quote: z.object({
    route: z.string(),
    direction: z.enum(["to-rome", "from-rome"]),
    amountIn: z.string(),
    amountOut: z.string(),
    // .min(1) — every valid quote has at least one step (the user-signed source-tx).
    // An empty array reaches verifyEvmTxMatchesQuote(quote.steps[0], ...) as undefined
    // and crashes with a 500; reject upfront with a clean 400 instead.
    // .passthrough() on the quote object is intentional: the endpoint accepts the
    // full quote object returned by /v1/quote (with sender, recipient, fee,
    // etaSeconds, outputs), and those non-declared fields are read via explicit
    // (quote as any).sender / .recipient casts below. Don't tighten to .strict() —
    // it would break integrators submitting the full quote shape.
    steps: z.array(z.any()).min(1),
  }).passthrough(),
  step1TxHash: z.string(),
  // Trustless settle: the user's EIP-712 SettleAuthorization signature,
  // signed over the completed struct AFTER the burn. Optional — absent means
  // the caller uses the legacy v1 (bridge_settler_key) settle path.
  userSettleSig: z.string().optional(),
});

interface EthereumReader { readTx(hash: string): Promise<{ to: string; data: string; value: string } | null>; }

interface EvmPoolLike {
  readTx(entry: { chainId: number; rpcUrl?: string | undefined; name?: string | undefined }, hash: string): Promise<{ to: string; data: string; value: string } | null>;
  simulateTx?(entry: { chainId: number; rpcUrl?: string | undefined; name?: string | undefined }, tx: { from: string; to: string; data: string; value?: string }): Promise<{ ok: boolean; revertReason?: string }>;
}

declare module "fastify" {
  interface FastifyInstance {
    ethereumReader?: EthereumReader;
    evmPool?: EvmPoolLike;
  }
}

/**
 * A sponsor step only ever becomes actionable after the vendor attested the
 * user's source tx (the poller gates on it) — so a confirmed sponsor step is
 * proof the burn mined. Step 1 has no confirmation watcher of its own; flip
 * it here or records can never reach outcome: complete.
 */
async function confirmAttestedStep1(store: TransferStore, id: string) {
  const record = await store.get(id);
  if (!record) return null;
  const step1 = record.steps.find((s) => s.n === 1);
  if (!step1 || step1.status !== "submitted") return record;
  const attested = record.steps.some((s) => s.attestation || s.vaa || (s.status === "confirmed" && s.n !== 1));
  if (!attested) return record;
  return store.updateStep(id, 1, { status: "confirmed", confirmedAt: new Date().toISOString() });
}

export async function transfersRoutes(app: FastifyInstance, _cfg: Config) {
  const registry = new CachedRegistry(new RegistryClient({ source: { kind: "local", path: _cfg.registryPath } }), 60_000);

  /**
   * Resolve the record stamp from the REGISTRY (never caller data) at
   * registration. CCTP routes only; version pinned to 1 until the V2 quote
   * builder flips (the stamp must match the calldata the quote emitted).
   * Resolution failure degrades to an unstamped record (backfill covers) —
   * verification already passed; stamping must not block registration.
   */
  async function resolveStamp(quote: { route: string; cctpVersion?: number; sourceChainId?: number; outputs?: Array<{ chainId?: string }>; steps: Array<{ chain?: string }> }): Promise<{ stamp: RecordStampT; entry: { chainId: number; rpcUrl?: string | undefined; name?: string | undefined } } | undefined> {
    if (!quote.route.startsWith("usdc-cctp")) return undefined;
    try {
      const romeChainId =
        quote.outputs?.find((o) => o.chainId)?.chainId ??
        quote.steps.map((s) => /^rome-(\d+)$/.exec(s.chain ?? "")?.[1]).find(Boolean);
      if (!romeChainId) return undefined;
      const chain = (await registry.listChains()).find((c) => c.chainId === romeChainId);
      if (!chain) return undefined;
      // Version/source come from the QUOTE (they must match the emitted
      // calldata); addresses are still resolved from the REGISTRY, so a lying
      // caller only produces a stamp that fails equality verification.
      if ((quote as { direction?: string }).direction === "from-rome") {
        // Outbound: the burn lives on the ROME chain; iris polls the Solana
        // domain; the burn target is the registry-live RomeBridgeWithdraw.
        const withdraw = liveContractAddress(chain, "RomeBridgeWithdraw");
        if (!withdraw || !chain.bridge?.cctpIrisApiBase || !chain.rpcUrl) return undefined;
        const stamp: RecordStampT = {
          sourceChainId: Number(chain.chainId),
          cctpVersion: 2,
          cctpDomain: chain.bridge.solana?.cctpDomain ?? 5,
          irisBase: chain.bridge.cctpIrisApiBase,
          cctpTokenMessenger: withdraw,
          // v6 burnUSDC selectors (3-arg per-destination + 2-arg back-compat) — registry-family constants.
          expectedSelectors: ["0x7ed19660", "0x259acd3b"],
          romeRpcUrl: chain.rpcUrl,
        };
        return { stamp, entry: { chainId: Number(chain.chainId), rpcUrl: chain.rpcUrl, name: chain.name ?? chain.slug } };
      }
      const cctpVersion = quote.cctpVersion === 2 ? 2 : 1;
      const stamp = stampFromChainConfig(chain, { cctpVersion, ...(quote.sourceChainId !== undefined ? { sourceChainId: quote.sourceChainId } : {}) });
      const entry = entryFor(chain.bridge, stamp.sourceChainId);
      if (!entry) return undefined;
      return { stamp, entry };
    } catch (err) {
      app.log.warn({ err }, "record stamp resolution failed — registering unstamped");
      return undefined;
    }
  }
  app.post("/transfers", async (req, reply) => {
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      const err = bridgeError("rome.bridge.request-invalid", parsed.error.message);
      reply.status(err.status);
      return { ...err };
    }
    const { quote, step1TxHash } = parsed.data;

    // Resolve the registry-bound transport stamp BEFORE verification: the
    // burn must match the stamped messenger + version, and the tx is fetched
    // via the record's own source-chain client (that IS the chainId check).
    const transport = await resolveStamp(quote as never);

    // Fail-closed stamping: a V2 or from-rome CCTP registration without a
    // resolved stamp would land unstamped → V1-Sepolia backfill → the poller
    // 404s the wrong IRIS path forever (Bug-B's disease, robustness flavor).
    // Reject loudly — the client re-quotes; nothing registers undeliverable.
    // (V1-shaped quotes may still register unstamped: the backfill IS correct
    // for them — that's its purpose.)
    const q = quote as { route: string; cctpVersion?: number; direction?: string };
    if (!transport && q.route.startsWith("usdc-cctp") && (q.cctpVersion === 2 || q.direction === "from-rome")) {
      // Same 400-class code the quote route uses for an unknown romeChainId —
      // the quote is caller data; an unresolvable chain is their input, not
      // our outage.
      const err = bridgeError("rome.bridge.asset-not-supported",
        "could not resolve the transport stamp for this quote (unknown Rome chain or incomplete registry entry) — re-quote and retry");
      reply.status(err.status);
      return { ...err };
    }

    // From-rome NON-CCTP routes (wormhole egress): the burn lives on the ROME
    // chain — verify equality via the registry chain's own RPC through
    // the pool, and stamp the claim step with the Rome RPC the poller needs
    // for sig resolution. Before this, these routes fell to the Sepolia-only
    // reader → readTx(romeBurn) null → 400: no wormhole egress could register.
    let romeEntry: { chainId: number; rpcUrl?: string | undefined; name?: string | undefined } | undefined;
    let romeRpcForClaim: string | undefined;
    if (!transport && q.direction === "from-rome" && q.route.includes("wormhole")) {
      const romeChainId = (quote.steps as Array<{ chain?: string }>)
        .map((s) => /^rome-(\d+)$/.exec(s.chain ?? "")?.[1]).find(Boolean);
      const chain = romeChainId ? (await registry.listChains()).find((c) => c.chainId === romeChainId) : undefined;
      if (!chain?.rpcUrl) {
        const err = bridgeError("rome.bridge.asset-not-supported",
          "could not resolve the Rome chain for this from-rome quote (unknown chain or missing rpcUrl) — re-quote and retry");
        reply.status(err.status);
        return { ...err };
      }
      romeEntry = { chainId: Number(chain.chainId), rpcUrl: chain.rpcUrl, name: chain.name ?? chain.slug };
      romeRpcForClaim = chain.rpcUrl;
    }

    // equality-only verification of the user-reported source tx against the quote step
    const pool = app.evmPool;
    const reader = app.ethereumReader;
    if (pool && (transport || romeEntry)) {
      const entry = transport?.entry ?? romeEntry!;
      const onchain = await pool.readTx(entry, step1TxHash);
      if (!onchain) {
        const err = bridgeError("rome.bridge.source-tx-not-found", `tx ${step1TxHash} not found on source chain ${entry.chainId}`);
        reply.status(err.status);
        return { ...err };
      }
      const result = verifyEvmTxMatchesQuote(quote.steps[0], onchain, transport?.stamp);
      if (!result.ok) {
        const err = bridgeError("rome.bridge.source-tx-mismatch", result.reason ?? "on-chain tx does not match quote");
        reply.status(err.status);
        return { ...err };
      }
    } else if (reader) {
      const onchain = await reader.readTx(step1TxHash);
      if (!onchain) {
        const err = bridgeError("rome.bridge.source-tx-not-found", `tx ${step1TxHash} not found on Ethereum`);
        reply.status(err.status);
        return { ...err };
      }
      const result = verifyEvmTxMatchesQuote(quote.steps[0], onchain, transport?.stamp);
      if (!result.ok) {
        const err = bridgeError("rome.bridge.source-tx-mismatch", result.reason ?? "on-chain tx does not match quote");
        reply.status(err.status);
        return { ...err };
      }
    }

    const store = new TransferStore(app.redis);
    // Optional caller-controlled idempotency. The "idempotency-key" header is
    // normalized to lowercase by Fastify; we accept either casing for safety.
    const idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["Idempotency-Key"] as unknown as string | undefined);
    const stamp = transport?.stamp;

    // Trustless settle: verify the user's authorization recovers to the
    // recipient over the completed struct (sourceTxHash = the burn), then
    // encrypt it at rest. A bad sig is rejected HERE — never reaches the
    // worker or Redis in plaintext.
    let encryptedSettleSig: string | null = null;
    let settleDeadline: number | null = null;
    const { userSettleSig } = parsed.data;
    if (userSettleSig) {
      const authReq = (quote as { signatureRequests?: Array<{ typedData?: { message?: Record<string, string> } }> }).signatureRequests?.[0];
      const typedData = authReq?.typedData;
      const deadline = typedData?.message?.deadline;
      // Expected signer = the settle step's server-stamped `user` (the Rome
      // recipient), NOT quote.recipient (the quote response doesn't carry it).
      const settleStep = quote.steps.find((s: { kind: string }) => s.kind === "settle-inbound-bridge-sponsored") as { user?: string } | undefined;
      const recipient = settleStep?.user ?? "";
      if (!typedData || !deadline) {
        const err = bridgeError("rome.bridge.source-tx-mismatch", "userSettleSig supplied but quote carries no settle authorization");
        reply.status(err.status);
        return { ...err };
      }
      // Verify against the exact typed-data the quote emitted, with the burn
      // hash filled. The on-chain program is the authoritative gate (recomputes
      // from registry truth); this early-rejects a bad sig before Redis.
      const verified = verifyAgainstTypedData(typedData as never, step1TxHash as `0x${string}`, recipient, userSettleSig);
      if (!verified.ok) {
        const err = bridgeError("rome.bridge.source-tx-mismatch", `settle authorization invalid: ${verified.reason}`);
        reply.status(err.status);
        return { ...err };
      }
      // Never store a settle authorization in plaintext. If trustless settle
      // is in use, ROW_ENCRYPTION_KEY_BASE64 must be provisioned — fail closed
      // rather than silently downgrade the at-rest control.
      const cipher = rowCipherFromEnv();
      if (!cipher) {
        const err = bridgeError("rome.bridge.chain-misconfigured", "settle authorization requires ROW_ENCRYPTION_KEY_BASE64 (at-rest encryption); refusing to store the signature in plaintext");
        reply.status(err.status);
        return { ...err };
      }
      encryptedSettleSig = cipher.encrypt(userSettleSig);
      settleDeadline = Number(deadline);
    }
    const id = await store.create({
      route: quote.route as never,
      direction: quote.direction,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      sender: (quote as any).sender ?? {},
      recipient: (quote as any).recipient ?? "",
      steps: quote.steps.map((s: any, i: number) =>
        i === 0
          ? { ...s, status: "submitted", txHashes: [step1TxHash] }
          : s.kind === "settle-inbound-bridge-sponsored"
            ? { ...s, status: "blocked", sourceTxHash: step1TxHash }
            // Wormhole claim steps get the REGISTRY-resolved Rome RPC the
            // poller uses to resolve the burn's Solana sig — server-stamped,
            // never caller data (mirrors the settle-step sourceTxHash rule).
            : romeRpcForClaim && /^wormhole-claim-/.test(s.kind ?? "")
              ? { ...s, status: "blocked", romeRpcUrl: romeRpcForClaim }
              : { ...s, status: "blocked" }),
      outcome: "pending",
      ...(stamp ? { stamp } : {}),
      userSettleSig: encryptedSettleSig,
      settleDeadline,
    }, idempotencyKey);
    const record = await store.get(id);
    return record;
  });

  app.get<{ Querystring: { address?: string } }>("/transfers", async (req, reply) => {
    const address = req.query.address;
    if (!address) {
      reply.status(400);
      const err = bridgeError("rome.bridge.request-invalid", "address query parameter is required");
      return { ...err };
    }
    const store = new TransferStore(app.redis);
    const records = await store.listByAddress(address);
    // Same public contract as GET /:id — never expose the (even encrypted)
    // settle authorization; surface the boolean instead.
    const transfers = records.map((record) => {
      const { userSettleSig, ...pub } = record as typeof record & { userSettleSig?: string | null };
      return { ...pub, settleAuthorized: !!userSettleSig };
    });
    return { transfers };
  });

  /**
   * Internal, token-gated: the co-deployed sponsor worker polls this for the ids
   * of all pending transfers, then drives tickOnce on each. Same gate as
   * settle-material (WORKER_INTERNAL_TOKEN); disabled when unset. Static path so
   * it resolves ahead of GET /transfers/:id.
   */
  app.get("/transfers/pending", async (req, reply) => {
    if (!workerAuthorized(req)) { reply.status(404); return { error: "not found" }; }
    const store = new TransferStore(app.redis);
    return { ids: await store.listPendingIds() };
  });

  app.get<{ Params: { id: string } }>("/transfers/:id", async (req, reply) => {
    const store = new TransferStore(app.redis);
    const record = await store.get(req.params.id);
    if (!record) {
      reply.status(404);
      const err = bridgeError("rome.bridge.source-tx-not-found", `transfer ${req.params.id} not found`);
      return { ...err };
    }
    // Never expose the (even encrypted) settle authorization on the public read.
    const { userSettleSig, ...pub } = record as typeof record & { userSettleSig?: string | null };
    return { ...pub, settleAuthorized: !!userSettleSig };
  });

  /**
   * SSE status push: replays the record's event
   * log after Last-Event-ID, then live-polls for new events; heartbeat
   * comments keep intermediaries from timing the stream out. Polling
   * multi-minute standard-tier transfers is the wasteful case this replaces.
   */
  app.get<{ Params: { id: string } }>("/transfers/:id/events", async (req, reply) => {
    const store = new TransferStore(app.redis);
    const record = await store.get(req.params.id);
    if (!record) {
      reply.status(404);
      const err = bridgeError("rome.bridge.source-tx-not-found", `transfer ${req.params.id} not found`);
      return { ...err };
    }
    const lastIdHeader = req.headers["last-event-id"];
    let lastSeq = Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader ?? 0) || 0;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(":connected\n\n");

    let closed = false;
    req.raw.on("close", () => { closed = true; });

    const flush = async () => {
      const events = await store.events.readAfter(req.params.id, lastSeq);
      for (const e of events) {
        reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
        lastSeq = e.seq;
      }
    };
    await flush();

    const poll = setInterval(() => { void flush(); }, 500);
    const heartbeat = setInterval(() => { if (!closed) reply.raw.write(":hb\n\n"); }, 15_000);
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (closed) { clearInterval(check); clearInterval(poll); clearInterval(heartbeat); resolve(); }
      }, 100);
    });
    reply.raw.end();
    return reply;
  });

  /**
   * Internal, token-gated: the co-deployed worker fetches the decrypted settle
   * authorization here (never over the public read). POST purges it once
   * settle is submitted. Gate shared with /worker/heartbeat — lib/worker-auth
   * (constant-time compare); WORKER_INTERNAL_TOKEN unset ⇒ disabled.
   */
  app.get<{ Params: { id: string } }>("/transfers/:id/settle-material", async (req, reply) => {
    if (!workerAuthorized(req)) { reply.status(404); return { error: "not found" }; }
    const store = new TransferStore(app.redis);
    const record = await store.get(req.params.id);
    if (!record || !record.userSettleSig) { reply.status(404); return { error: "no settle material" }; }
    const cipher = rowCipherFromEnv();
    let userSettleSig: string;
    try {
      userSettleSig = cipher ? cipher.decrypt(record.userSettleSig) : record.userSettleSig;
    } catch {
      reply.status(500);
      return { error: "settle material decrypt failed" };
    }
    const settleStep = record.steps.find((s) => s.kind === "settle-inbound-bridge-sponsored");
    return {
      userSettleSig,
      deadline: record.settleDeadline,
      sourceEvmChainId: String(record.stamp?.sourceChainId ?? settleStep?.sourceChain ?? ""),
    };
  });

  app.post<{ Params: { id: string }; Body: { purgeSettleMaterial?: boolean } }>("/transfers/:id/settle-material", async (req, reply) => {
    if (!workerAuthorized(req)) { reply.status(404); return { error: "not found" }; }
    if (!req.body.purgeSettleMaterial) { reply.status(400); return { error: "purgeSettleMaterial required" }; }
    const store = new TransferStore(app.redis);
    await store.purgeSettleMaterial(req.params.id);
    return { purged: true };
  });

  app.post<{ Params: { id: string; n: string }; Body: { txHash?: string; broadcastAt?: string; skip?: { degradation: string; reason?: string } } }>(
    "/transfers/:id/steps/:n",
    async (req, reply) => {
      const n = parseInt(req.params.n, 10);
      if (!Number.isFinite(n)) {
        reply.status(400);
        const err = bridgeError("rome.bridge.step-not-ready", `invalid step n: ${req.params.n}`);
        return { ...err };
      }
      const store = new TransferStore(app.redis);
      const record = await store.get(req.params.id);
      if (!record) {
        reply.status(404);
        const err = bridgeError("rome.bridge.source-tx-not-found", `transfer ${req.params.id} not found`);
        return { ...err };
      }
      const step = record.steps.find((s) => s.n === n);
      if (!step) {
        reply.status(404);
        const err = bridgeError("rome.bridge.step-not-ready", `step ${n} not in transfer`);
        return { ...err };
      }
      // Terminal sponsor decision: the settle was deliberately not executed
      // (e.g. OwnerInfo mint mismatch ⇒ wrapper mode). The step completes as
      // skipped and the record carries the degradation qualifier — outcome
      // keeps its existing enum (additive-within-/v1), never a new value.
      // (Kind is validated before readiness so a wrong-kind skip is a clean 400.)
      if (req.body.skip && step.kind !== "settle-inbound-bridge-sponsored") {
        reply.status(400);
        const err = bridgeError("rome.bridge.step-tx-mismatch", `skip is only valid on settle steps, not ${step.kind}`);
        return { ...err };
      }
      if (step.status !== "ready") {
        reply.status(409);
        const err = bridgeError("rome.bridge.step-not-ready", `step ${n} is ${step.status}, not ready`);
        return { ...err };
      }

      if (req.body.skip) {
        await store.updateStep(req.params.id, n, {
          status: "confirmed",
          skipped: true,
          confirmedAt: new Date().toISOString(),
        });
        await confirmAttestedStep1(store, req.params.id);
        return store.setDegradation(req.params.id, req.body.skip.degradation, req.body.skip.reason);
      }
      if (!req.body.txHash) {
        reply.status(400);
        const err = bridgeError("rome.bridge.step-tx-mismatch", "txHash or skip is required");
        return { ...err };
      }

      // User-paid DESTINATION claims (outbound): verify the reported tx
      // against the materialized claim calldata via the destination chain's
      // client — the same content-match trust model step-1 registration uses
      // (readTx binds the chain; to+data equality binds the payload). A
      // verified claim confirms the step; with the attested step 1 that
      // flips the record to outcome: complete (before this, outbound records
      // never completed and clients rendered a forever-pending transfer).
      // Unreadable tx (still propagating / no RPC configured for the chain)
      // lands "submitted" — honest, retriable by the poller-less client.
      const USER_CLAIM_KINDS = new Set(["cctp-claim-on-destination", "wormhole-claim-on-ethereum", "wormhole-claim-on-destination"]);
      if (USER_CLAIM_KINDS.has(step.kind)) {
        const chainMatch = /^evm-(\d+)$/.exec(step.chain ?? "");
        const expected = step.unsignedTxs?.[step.unsignedTxs.length - 1] as
          | { to?: string; data?: string }
          | undefined;
        let verified = false;
        if (chainMatch && expected && app.evmPool) {
          const onchain = await app.evmPool.readTx({ chainId: Number(chainMatch[1]) }, req.body.txHash);
          if (onchain) {
            if (
              onchain.to.toLowerCase() !== (expected.to ?? "").toLowerCase() ||
              onchain.data.toLowerCase() !== (expected.data ?? "").toLowerCase()
            ) {
              reply.status(400);
              const err = bridgeError("rome.bridge.step-tx-mismatch",
                `claim tx ${req.body.txHash} does not match the materialized claim calldata`);
              return { ...err };
            }
            verified = true;
          }
        }
        let updatedClaim = await store.updateStep(req.params.id, n, {
          status: verified ? "confirmed" : "submitted",
          txHashes: [...(step.txHashes ?? []), req.body.txHash],
          ...(verified ? { confirmedAt: new Date().toISOString() } : {}),
        });
        if (verified) {
          updatedClaim = await confirmAttestedStep1(store, req.params.id) ?? updatedClaim;
        }
        return updatedClaim;
      }

      // Sponsor-signed Solana steps are reported AFTER sendAndConfirm — the
      // signature is already confirmed, so the step lands as confirmed and its
      // dependents unblock (the settle step becomes ready). User-signed steps
      // stay "submitted" until a confirmation watcher advances them.
      const SPONSOR_CONFIRMED_KINDS = new Set(["cctp-receive-message", "wormhole-complete-transfer-wrapped", "ensure-ata", "settle-inbound-bridge-sponsored"]);
      const isSponsorStep = SPONSOR_CONFIRMED_KINDS.has(step.kind);
      let updated = await store.updateStep(req.params.id, n, {
        status: isSponsorStep ? "confirmed" : "submitted",
        txHashes: [...(step.txHashes ?? []), req.body.txHash],
        ...(isSponsorStep ? { confirmedAt: new Date().toISOString() } : {}),
      });
      if (isSponsorStep) {
        updated = await confirmAttestedStep1(store, req.params.id) ?? updated;
      }
      if (isSponsorStep && updated) {
        for (const s of updated.steps) {
          if (s.status !== "blocked") continue;
          const blockers = Array.isArray(s.blockedBy) ? s.blockedBy : s.blockedBy ? [s.blockedBy] : [];
          const stepBlockers = blockers.filter((b) => /^step-\d+$/.test(b));
          const allDone = stepBlockers.every((b) => {
            const dep = updated!.steps.find((x) => x.n === Number(b.slice(5)));
            // step-1 (the user's source tx) counts once the burn is attested —
            // vendor attestation is the proof of mining, mirroring the poller.
            if (dep?.n === 1) return dep.status === "confirmed" || !!(s.attestation || s.vaa);
            return dep?.status === "confirmed";
          });
          // Attestation-class gates must ALSO be satisfied before readying.
          const vendorGatesOk =
            (!blockers.includes("circle-attestation") || !!s.attestation) &&
            (!blockers.includes("wormhole-vaa") || !!s.vaa);
          if (stepBlockers.length > 0 && allDone && vendorGatesOk) {
            updated = await store.updateStep(req.params.id, s.n, { status: "ready" });
          }
        }
      }
      return updated;
    },
  );
}
