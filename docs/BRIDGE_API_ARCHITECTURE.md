# Rome Bridge API — Architecture & Cleanup (2026-07-05)

The bridge API is a **stateless Fastify service** that quotes and orchestrates asset
transfers between external chains and Rome. It holds **no on-chain signing keys**
in the API process; the worker holds only a Solana fee-payer (never an authority).
This doc is the post-cleanup architecture reference — the rails, the builders, the
asset-agnostic model, on-chain dependencies, and what was consolidated.

## 0. What this service IS (and is not)

**It IS** the Rome Bridge's **off-chain orchestrator + fee-sponsor**: it quotes which
on-chain calls a transfer needs, verifies the source tx, and (for inbound only)
runs a worker that sponsors the permissionless completion. **It is NOT a
fund-custodying bridge** — the API process holds no keys; the worker holds only a
Solana **fee-payer** (never an authority), and by invariant *sponsors credit, never
debit*.

**The actual bridge — the asset movement + the trust — lives on-chain**, not in
this service: `RomeBridgeWithdraw` (egress), the rome-evm `settle_inbound_bridge`
program (inbound credit), and the Circle CCTP / Wormhole programs. This service
tells the wallet what to sign and, for inbound, pays the fee to trigger a step the
user already authorized on-chain. Per direction:

- **Outbound (Rome → L2/Solana):** quote-only. The user signs + submits the
  `RomeBridgeWithdraw` call; far-side redemption is protocol-native (Circle
  attestation / Wormhole VAA). The worker is not involved.
- **Inbound (L2/Solana → Rome):** quote the source-side lock/burn (user signs it),
  then the **worker sponsors** the completion (`receiveMessage` /
  `complete_transfer_wrapped` / `settle_inbound_bridge`) so the user needs no
  gas/keys on the destination.

## 1. Rails (5) — one builder pair each, registry-resolved

| Rail | Route keys | Asset(s) | Mechanism |
|---|---|---|---|
| **CCTP** | `usdc-cctp-{to,from}-rome` | USDC | Circle depositForBurn/receiveMessage; per-call destination domain (v6/v2). In + out. |
| **Wormhole (ETH)** | `eth-wormhole-{to,from}-rome` | ETH | `wrapAndTransferETH` → guardian VAA → `complete_transfer_wrapped` (in); `burnETH` (out). |
| **Solana-native (fixed)** | `usdc-solana-{to,from}-rome`, `sol-solana-{to,from}-rome` | USDC, SOL/wSOL | SPL `transferChecked` (in, native-wrap for SOL); gas-relative egress (out). |
| **Solana SPL/LST (asset-agnostic)** | `spl-solana-{to,from}-rome` (asset `SPL`) | **any SPL/LST** | `transferChecked` in; mint-explicit `RomeBridgeWithdraw.bridgeOutToSolana(recipient,amount,mint)` out. Mint+decimals ride on `splAsset`. |
| **Generic Wormhole egress (asset-agnostic)** | `token-wormhole-from-rome` (asset `TOKEN`) | **any wrapped asset** | `approveWormholeBurn` + `burnToWormhole(wrapper,amount,recipient,targetChain)` on RomeBridgeWithdraw; EVM→Wormhole chain-id map; VAA redeemed Wormhole-native. |

All contract addresses resolve at request time from the **registry** (`liveContractAddress(chain, "RomeBridgeWithdraw")`, `chain.contracts`/`tokens`/`bridge`). Nothing is hardcoded — the registry is the single source of truth.

## 2. The two governing questions (mental model)

1. **Is the asset the destination Rome chain's gas mint?** — read from the rome-evm program's **on-chain OwnerInfo PDA** (authoritative; the registry `gasToken.mintId` is a drift-prone mirror, fallback only). Gas mint + `intent:"gas"` → settle as native gas; else → wrapper. LSTs are never a gas mint ⇒ always wrapper.
2. **Which external chain holds the asset?** — Solana (SPL/LST rail) or an EVM L2 (CCTP for USDC, Wormhole for the rest). **The Rome side is always an ERC20-SPL wrapper over the underlying mint**; egress sends the underlying mint back out.

## 3. On-chain dependencies

- **`RomeBridgeWithdraw` (live pointer, resolved from registry)** — the egress home for Rome→Solana SPL (`bridgeOutToSolana`, mint-explicit/agnostic), CCTP-out (`burnUSDC`), ETH Wormhole-out (`burnETH`), and generic Wormhole-out (`burnToWormhole` + allowlist setters). **v8 `0xc1543b5e` is the current Hadrian live pointer** (registry 7.0.0). v8 adds owner + `setWormholeAssetAllowed`/`setWormholeTargetChainAllowed` so new Wormhole assets/chains are enabled without a redeploy.
- **rome-evm program OwnerInfo PDA** — gas-mint resolution (`src/chains/gas-mint-resolver.ts`, behind `SOLANA_RPC_URL`).
- **Solana SPL Token + ATA programs, Wormhole Token/Core Bridge, Circle CCTP programs** — per-chain ids from the registry `bridge.solana` block.

## 3a. Trustless settle — why it needs an on-chain change (the Rome EVM)

Inbound **settle** — crediting the user's native gas on Rome for a bridged-in
deposit — is an **on-chain mint/credit** by the rome-evm program (into the user's
Balance PDA). So *who is credited, on which chain, how much* is enforced **inside
the program**, not by this API. An off-chain gate can always be bypassed by a
caller submitting straight to the program — so trustlessness has to be enforced
on-chain.

**Before the trustless-settle change**, settle either needed a privileged **settler key**, or left a
residual **"chainId-redirect within the same program"** risk: a caller could tamper
`chainId` A→B (a different chain on the same program with the same gas mint), pass
the off-chain gates, and land the user's gas on the wrong chain (misdirection,
recoverable but wrong).

**The Rome EVM change (`settle_inbound_bridge` v2)** adds
an on-chain-verified, user-signed authorization. It provides:
1. **On-chain EIP-712 verification** of a user-signed `SettleAuthorization` binding
   `(chainId, mint, amount, sourceChain, sourceTxHash, deadline)`. The program
   recovers the signer and rejects if it isn't the user (the `SignerNotUser`
   revert — the one the client-digest fix chased when `domain.chainId` was
   stringified; keep it numeric).
2. **No settler key** — because the authorization is user-signed and verified
   in-program, **any caller can submit**. So the sponsor worker is a **fee-payer
   only, credit-only** with no authority. Proven E2E: Monad→Hadrian, exact `1e18`
   credited, **no settler key**.
3. **Destination binding** — the program rejects crediting any chain/mint/amount
   the user didn't sign for, closing the chainId-redirect. A hostile/buggy sponsor
   **cannot misdirect or steal**.
4. **This is what makes the sponsor model trustless** — it moves the trust
   boundary from "trust the settler/sponsor" to "the program verifies the user's
   own signed intent." The off-chain sponsor can only *trigger* what's on-chain-
   authorized.

The two halves: **the Rome EVM** = the on-chain enforcement (the program);
**rome-bridge-api** = the client half (build + sign the EIP-712 authorization,
hand it to the sponsor via `POST /v1/transfers`). Neither alone is trustless.

## 4. Cleanup / consolidation done this arc

- **Asset-agnostic rails introduced** — `spl-solana-*` (any SPL/LST) + `token-wormhole-from-rome` (any wrapped asset) replace the need for a per-asset builder per LST. Mint/wrapper/decimals are request parameters, not baked constants. Fixed USDC/ETH/SOL rails remain for the common path; `SPL`/`TOKEN` are meta-rails (not listed in `/v1/assets`, used via explicit `splAsset`).
- **Egress bug fixed (root cause):** Rome→Solana SPL egress must target **`RomeBridgeWithdraw`** (mint-explicit 3-arg), NOT the registry's cached ERC20-SPL wrappers — those cached wrappers carry **no egress selectors** and revert empty-`0x`. The prior builders wrongly called the wrapper. `bridgeOutToSolana` is mint-agnostic (operates on the caller's PDA-ATA) so no per-mint wrapper contract is needed.
- **Gas-vs-wrapper moved on-chain** — resolved from OwnerInfo, not the registry mirror, including the settle-auth mint.
- **Keep-as-wrapper intent** uniform across inbound rails (gas vs wrapper is the user's choice when the asset IS the gas mint).
- **Harness reliability** — ATA-existence probes use `getTokenAccountBalance` (fast on a dedicated Solana RPC) not `getAccountInfo` (times out there → false "absent").

## 5. Proven live (Hadrian 200010 + Solana devnet + Sepolia/L2s)

Solana-native USDC/SOL in+out; **LSTs bSOL/mSOL/jitoSOL in+out** (real, staked); CCTP USDC in + out→Monad/Fuji/Base; **ETH-in Wormhole** (Sepolia→Rome, wrapped-ETH minted); **wETH-out Wormhole** (Rome→Sepolia, on v8); trustless settle v2.

**Remaining (operator/per-asset, not code):** enabling a *new* non-wETH asset for Wormhole-out needs its ERC20SPL wrapper + `setWormholeAssetAllowed` + Wormhole attestation on the destination (empirically confirmed: an un-attested asset clears the allowlist but the Wormhole CPI reverts).

## 6. Endpoints (surface)
`POST /v1/quote` (asset ∈ USDC/ETH/SOL/SPL/TOKEN + direction + source/dest + `splAsset` for the meta-rails), `POST /v1/transfers` (register a source tx; the spec equality verification), `GET /v1/transfers/{id}`, `GET /v1/assets` (concrete fixed-asset routes), `GET /v1/chains`. Invariants enforced: destinations derived from user identity (never caller fields); sponsors credit-only; source-tx equality verification.
