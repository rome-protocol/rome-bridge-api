/**
 * Per-record transport stamp.
 *
 * The FULL resolved tuple — version, domain, iris base, and the version-keyed
 * contract addresses — is frozen onto the record at registration. Downstream
 * stages (poller, lens, receive builder, verifier) branch on the record, never
 * on live config: a registry edit mid-flight must never strand or retarget an
 * in-flight transfer.
 */
import type { ChainConfig } from "../registry/types.js";
import type { RecordStampT } from "./types.js";
import { assetFor, cctpDomainFor, entryFor, resolveCctpAddresses } from "../registry/catalog.js";

export interface StampOpts {
  /**
   * The CCTP version the QUOTE was built with — must match the emitted
   * calldata, not the registry's declared version (the quote builder pins V1
   * until the V2 quote task flips it).
   */
  cctpVersion: 1 | 2;
  /** Omitted ⇒ the chain's default source (catalog entry 0). */
  sourceChainId?: number | undefined;
}

export function stampFromChainConfig(chain: ChainConfig, opts: StampOpts): RecordStampT {
  const entry = opts.sourceChainId === undefined ? entryFor(chain.bridge) : entryFor(chain.bridge, opts.sourceChainId);
  if (!entry) throw new Error(`no source chain ${opts.sourceChainId ?? "(default)"} in the bridge catalog for chain ${chain.chainId}`);

  const domain = cctpDomainFor(chain.bridge, entry);
  if (domain === undefined) throw new Error(`source chain ${entry.chainId} has no cctpDomain`);

  const root = chain.bridge?.cctpIrisApiBase;
  if (!root) throw new Error(`chain ${chain.chainId} has no cctpIrisApiBase`);
  // Each version's client expects its own base convention: V1 pollers hit
  // {base}/attestations/… with /v1 baked into the base; V2 builds /v2/… paths
  // from the root.
  const irisBase = opts.cctpVersion === 1 ? `${root.replace(/\/$/, "")}/v1` : root;

  const addrs = resolveCctpAddresses(entry, opts.cctpVersion);
  const usdcRow = assetFor(chain.bridge, { symbol: "USDC", ...(opts.sourceChainId !== undefined ? { sourceChainId: opts.sourceChainId } : {}) });

  const stamp: RecordStampT = {
    sourceChainId: entry.chainId,
    cctpVersion: opts.cctpVersion,
    cctpDomain: domain,
    irisBase,
  };
  if (addrs.tokenMessenger) stamp.cctpTokenMessenger = addrs.tokenMessenger;
  if (addrs.messageTransmitter) stamp.cctpMessageTransmitter = addrs.messageTransmitter;
  if (usdcRow?.sourceEvm?.address) stamp.burnToken = usdcRow.sourceEvm.address;
  return stamp;
}
