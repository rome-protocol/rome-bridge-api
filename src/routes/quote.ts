import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Config } from "../config.js";
import { RegistryClient } from "../registry/client.js";
import { CachedRegistry } from "../registry/cache.js";
import { resolveRouteKey, buildQuote } from "../route-builders/index.js";
import { bridgeError } from "../errors.js";
import { CircleFeesProbe } from "../cctp/fees.js";
import { buildSettleAuthorizationRequest } from "../cctp/settle-auth.js";
import { PublicKey, Connection } from "@solana/web3.js";
import { makeGasMintResolver } from "../chains/gas-mint-resolver.js";
import { cctpDomainFor, entryFor, mergedCatalog } from "../registry/catalog.js";
import { caip2ForEvm, chainRefForStep, parseSourceChainInput } from "../lib/caip2.js";

/** Accepts a bare chain id (number or numeric string) or CAIP-2 eip155:<id>. */
const SourceChainId = z
  .union([z.number().int(), z.string().regex(/^(eip155:)?\d+$/)])
  .transform((v) => (typeof v === "number" ? v : Number(String(v).replace(/^eip155:/, ""))));

const QuoteRequest = z.object({
  asset: z.enum(["USDC", "ETH", "SOL", "SPL", "TOKEN"]),
  // Asset-agnostic rails: SPL (Solana-native, needs mint+decimals) and TOKEN
  // (generic Wormhole egress, needs wrapper). One optional object serves both.
  splAsset: z.object({ mint: z.string(), decimals: z.number().int().min(0).max(18), symbol: z.string().optional(), wrapper: z.string().optional() }).optional(),
  direction: z.enum(["to-rome", "from-rome"]),
  // Legacy symbolic rail OR CAIP-2 (eip155:<id> / solana:<genesis-prefix>) — dual-accept per the Sunset policy.
  sourceChain: z.string(),
  sourceChainId: SourceChainId.optional(),
  destinationChainId: SourceChainId.optional(),
  speed: z.enum(["standard", "fast"]).optional(),
  simulate: z.boolean().optional(),
  deadlineSec: z.number().int().optional(),
  romeChainId: z.string(),
  intent: z.enum(["gas", "wrapper"]).optional(),
  amount: z.string().regex(/^\d+$/),
  sender: z.object({ ethereum: z.string().optional(), solana: z.string().optional(), rome: z.string().optional() }),
  recipient: z.string(),
});

/**
 * Settle-authorization deadline policy (the deadline policy): 1h default,
 * [5min, 24h] bounds, AND floored above the transfer's own ETA + margin. A
 * deadline shorter than the attestation latency (standard-tier CCTP ~18min)
 * would expire before the settle can run — the worker then can't settle and the
 * record would otherwise stall. Floor at eta+margin so the signed window always
 * outlasts the transfer it authorizes.
 */
export function settleDeadlineSec(requestedSec: number | undefined, etaSeconds: number): number {
  const DEFAULT = 3600, MIN = 300, MAX = 86_400, ETA_MARGIN = 900;
  const requested = requestedSec === undefined ? DEFAULT : requestedSec;
  const floored = Math.max(requested, etaSeconds + ETA_MARGIN);
  return Math.min(MAX, Math.max(MIN, floored));
}

export async function quoteRoutes(app: FastifyInstance, cfg: Config) {
  const client = new RegistryClient({ source: { kind: "local", path: cfg.registryPath } });
  const cached = new CachedRegistry(client, 60_000);
  const feesProbe = new CircleFeesProbe();
  // On-chain gas-mint resolver (rome-evm OwnerInfo). Present only when the
  // a Solana RPC is configured; absence → builders fall back to the
  // registry mirror. Cached per (program, chain) with a 60s TTL internally.
  const gasMintResolver = cfg.solanaRpcUrl
    ? makeGasMintResolver(new Connection(cfg.solanaRpcUrl, "confirmed"))
    : undefined;

  app.post("/quote", async (req, reply) => {
    const parsed = QuoteRequest.safeParse(req.body);
    if (!parsed.success) {
      const err = bridgeError("rome.bridge.request-invalid", parsed.error.message);
      reply.status(err.status);
      return { ...err };
    }
    const input = parsed.data;

    // Dual-accept the source chain: symbolic rail (Sunset window) or CAIP-2.
    let sourceParsed;
    try {
      sourceParsed = parseSourceChainInput({ sourceChain: input.sourceChain, sourceChainId: input.sourceChainId });
    } catch (e) {
      const msg = (e as Error).message;
      const err = bridgeError(/conflict/i.test(msg) ? "rome.bridge.source-chain-conflict" : "rome.bridge.asset-not-supported", msg);
      reply.status(err.status);
      return { ...err };
    }
    if (sourceParsed.symbolicUsed) {
      // RFC 8594: symbolic chain names deprecate on the published Sunset date.
      reply.header("Sunset", process.env.SYMBOLIC_CHAINS_SUNSET ?? "Fri, 02 Oct 2026 00:00:00 GMT");
    }
    input.sourceChainId = sourceParsed.sourceChainId ?? input.sourceChainId;

    const chains = await cached.listChains();
    const chain = chains.find((c) => c.chainId === input.romeChainId);
    if (!chain) {
      const err = bridgeError("rome.bridge.asset-not-supported", `unknown romeChainId ${input.romeChainId}`);
      reply.status(err.status);
      return { ...err };
    }
    const routeKey = resolveRouteKey(input.asset, input.direction, sourceParsed.rail);

    // Registry-published program id only — deriving mintRecipient PDAs against
    // a fallback program strands funds on a program no live chain reads.
    const programId = chain.romeEvmProgramId;
    if (!programId) {
      const err = bridgeError("rome.bridge.chain-misconfigured", `chain ${input.romeChainId} has no romeEvmProgramId in the registry`);
      reply.status(err.status);
      return { ...err };
    }

    try {
      // Fast is quote-time capability from Circle's fees endpoint (fail-closed
      // to standard inside the builder when unavailable).
      let fast;
      if (input.speed === "fast" && routeKey === "usdc-cctp-to-rome") {
        const entry = input.sourceChainId === undefined ? entryFor(chain.bridge) : entryFor(chain.bridge, input.sourceChainId);
        const irisRoot = chain.bridge?.cctpIrisApiBase;
        const srcDomain = entry ? cctpDomainFor(chain.bridge, entry) : undefined;
        const dstDomain = chain.bridge?.solana?.cctpDomain;
        if (entry && irisRoot && srcDomain !== undefined && dstDomain !== undefined) {
          fast = await feesProbe.fastQuote(irisRoot, srcDomain, dstDomain);
        }
      }
      // Authoritative gas mint from the rome-evm program's on-chain OwnerInfo
      // (the registry is a mirror that can drift). undefined when the RPC is
      // unset / read failed — builders fall back to the registry mirror.
      const onchainGasMint = gasMintResolver
        ? (await gasMintResolver.resolve(programId, chain.chainId)) ?? undefined
        : undefined;
      const quote = buildQuote(routeKey, { ...input, chain, programId, onchainGasMint, ...(fast ? { fast } : {}) });
      // Echo the request identities: the transfer record (and its address
      // index) is built from the SUBMITTED quote's sender/recipient.
      quote.sender = input.sender;
      quote.recipient = input.recipient;

      // Responses emit CAIP-2 + a human chainName alongside the legacy labels.
      const catalog = mergedCatalog(chain.bridge);
      const defaultEvmChainId = catalog[0]?.chainId ?? 11155111;
      const solanaCluster = (chain.solana as { cluster?: string } | undefined)?.cluster ?? "devnet";
      const entryName = (id: number) => catalog.find((e) => e.chainId === id)?.name;
      for (const s of quote.steps) {
        // First-class sponsor attribution (successor to userSigns/sponsorPaysFees,
        // which stay emitted for the Sunset window). "partner" arrives with keys.
        if (s.userSigns !== undefined) s.sponsor = s.userSigns ? "user" : "rome";
        const ref = chainRefForStep(s.chain, { defaultEvmChainId, solanaCluster });
        if (!ref) continue;
        s.chainRef = ref;
        const evm = /^eip155:(\d+)$/.exec(ref);
        s.chainName = evm
          ? (String(evm[1]) === chain.chainId ? (chain.name ?? `rome-${chain.chainId}`) : (entryName(Number(evm[1])) ?? `evm-${evm[1]}`))
          : "Solana";
      }
      if (quote.sourceChainId !== undefined) {
        quote.sourceChainRef = caip2ForEvm(quote.sourceChainId);
      }
      // Trustless settle: gas-mode CCTP inbound quotes carry
      // the user's EIP-712 SettleAuthorization template. The wallet signs it
      // AFTER broadcasting the burn (the struct binds sourceTxHash), then
      // POST /transfers submits the sig. Non-gas / non-CCTP quotes carry [].
      quote.signatureRequests = [];
      const settleStep = quote.steps.find((s) => s.kind === "settle-inbound-bridge-sponsored");
      const gasOutput = quote.outputs?.find((o) => o.kind === "gas");
      if (settleStep && gasOutput && quote.sourceChainId !== undefined && quote.cctpVersion === 2) {
        // On-chain OwnerInfo is authoritative for the gas mint the settle
        // program will accept; the registry mirror is only a fallback when the
        // RPC read is unavailable. Using the wrong mint here → SignerNotUser.
        const gasMintId = onchainGasMint ?? chain.gasToken?.mintId;
        if (gasMintId) {
          const deadlineSec = settleDeadlineSec(input.deadlineSec, (quote as { etaSeconds?: number }).etaSeconds ?? 0);
          const req = buildSettleAuthorizationRequest({
            romeEvmProgramId: new PublicKey(programId),
            sourceEvmChainId: BigInt(quote.sourceChainId),
            destinationChainId: BigInt(chain.chainId),
            mint: new PublicKey(gasMintId),
            amount: BigInt(quote.amountOut),
            sourceChain: BigInt(quote.sourceChainId),
            deadline: BigInt(Math.floor(Date.now() / 1000) + deadlineSec),
          });
          quote.signatureRequests = [req as never];
        }
      }

      // Opt-in read-only preflight of the user-signed step-1 txs (EVM only) —
      // best-effort: no pool wired or non-EVM step-1 ⇒ fields simply absent.
      if (input.simulate && app.evmPool?.simulateTx && input.sender.ethereum && quote.sourceChainId !== undefined) {
        const entry = entryFor(chain.bridge, quote.sourceChainId);
        const step1 = quote.steps[0];
        if (entry && step1?.unsignedTxs) {
          for (const tx of step1.unsignedTxs) {
            tx.simulation = await app.evmPool.simulateTx(entry, {
              from: input.sender.ethereum, to: tx.to, data: tx.data, value: tx.value,
            });
          }
        }
      }
      return quote;
    } catch (caught: unknown) {
      const e = caught as { code?: unknown; status?: unknown; message?: string };
      if (e?.code && e?.status && typeof e.status === "number") {
        reply.status(e.status);
        return { ...e };
      }
      throw caught;
    }
  });
}
