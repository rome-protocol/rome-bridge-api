# Rome Bridge API

HTTP API for bridging assets between Ethereum, Solana, and Rome chains.

This document is the integrator reference. The API exposes deterministic bridge primitives — quote a route, register a transfer, drive it to completion — without holding user keys or custody.

---

## Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Base URL and versioning](#base-url-and-versioning)
- [Conventions](#conventions)
- [The route catalog](#the-route-catalog)
- [Endpoint reference](#endpoint-reference)
  - [`GET /v1/health`](#get-v1health)
  - [`GET /v1/assets`](#get-v1assets)
  - [`GET /v1/chains`](#get-v1chains)
  - [`POST /v1/quote`](#post-v1quote)
  - [`POST /v1/transfers`](#post-v1transfers)
  - [`GET /v1/transfers`](#get-v1transfers)
  - [`GET /v1/transfers/{id}`](#get-v1transfersid)
  - [`POST /v1/transfers/{id}/steps/{n}`](#post-v1transfersidstepsn)
- [Transfer lifecycle](#transfer-lifecycle)
- [Error reference](#error-reference)
- [Worked example](#worked-example-inbound-usdc-via-cctp)
- [Glossary](#glossary)

---

## Overview

The Bridge API turns a cross-chain bridge into a stateless HTTP surface. A caller:

1. **Quotes** a route (`POST /v1/quote`) — gets back the chain of unsigned transactions the user must sign to complete the bridge.
2. **Registers** a transfer after the user signs and broadcasts step 1 (`POST /v1/transfers`) — the API verifies the on-chain source tx matches the quote.
3. **Polls** the transfer (`GET /v1/transfers/{id}`) — the API advances state automatically as attestations arrive from upstream bridge networks (Circle's CCTP and Wormhole).
4. **Reports** subsequent broadcasts (`POST /v1/transfers/{id}/steps/{n}`) — for steps the user signs after step 1.

The API **does not** hold user keys, take custody of funds, or sign on behalf of the user. Every transaction is constructed unsigned and returned for the user's wallet to sign.

---

## Authentication

**v1.0 does not require an API key.** Distribution is controlled out-of-band: the API URL is shared only with onboarded integrators. There is no signup flow or token endpoint.

When per-integrator rate limits and key-scoped quotas land (planned for a future version), they will be additive — existing zero-auth callers continue to work until explicitly required to upgrade.

---

## Base URL and versioning

The URL is provided to integrators directly. All endpoints live under the `/v1/` prefix:

```
https://<your-bridge-api-host>/v1/<endpoint>
```

**Versioning policy.** The `/v1/` prefix is locked. Inside `v1`, only **additive, non-breaking changes** are made — new fields on responses, new optional request fields, new endpoints, new error codes. Breaking changes ship under a new prefix (`/v2/`) and `/v1/` continues to work in parallel during a deprecation window.

What counts as breaking:
- Removing or renaming a response field
- Changing the type of a response field
- Adding a required request field
- Changing an HTTP status code for an existing condition
- Removing or renaming an error code

What does **not** count as breaking:
- Adding optional request fields
- Adding response fields
- Adding new error codes (callers should treat unknown error codes as failures)
- Performance / latency changes
- Adding new routes to `/v1/assets`

---

## Conventions

**Amounts are always strings of base-unit integers.** USDC has 6 decimals — `"1000000"` means 1 USDC. ETH has 18 decimals — `"1000000000000000000"` means 1 ETH. SOL has 9 decimals — `"1000000000"` means 1 SOL. Floats are never accepted; the API parses amounts as `BigInt` and rejects non-integer values.

**Chain identifiers.** Rome chains are identified by their numeric `chainId` (e.g. `"200010"` for the public Hadrian testnet). Always pass as a string.

**Addresses.**
- Ethereum / Rome EVM addresses: 20-byte hex strings, lowercase preferred, `0x`-prefixed (`"0x3403e0de09bc76ca7d74762f264e4f6b649a0562"`).
- Solana addresses: base58 (`"55R41dbRU13QhLpAgha1841wR5M6sAcZhXd4S1LGupBn"`).

**Times.** ISO 8601 with timezone (`"2026-05-22T10:30:00Z"`).

**Error responses** use a uniform shape — see the [error reference](#error-reference).

**Content-Type.** All POST bodies are JSON. Set `Content-Type: application/json`.

**Idempotency.** `POST /v1/transfers` is idempotent on two keys:
1. **Natural key** — `(romeChainId, step1TxHash)`. Submitting the same source-tx hash twice returns the same transfer record. Always active.
2. **Caller-supplied** — `Idempotency-Key` request header. Returns the same record for any retry inside a 24-hour window. Useful before `step1TxHash` is known (e.g. retrying a `POST` that failed at the network layer with no on-chain side-effect).

Both checks are evaluated on every `POST`. Natural key wins if both indicate the same record; the keys never produce conflicting answers because Idempotency-Key is caller-scoped.

---

## The route catalog

The API supports eleven routes — five assets (USDC, ETH, SOL, any SPL token, generic TOKEN egress) across the two directions, with separate routes per source chain where both apply:

| Route key | Asset | Source chain | Direction | Bridge mechanism |
|---|---|---|---|---|
| `usdc-cctp-to-rome` | USDC | any catalog EVM chain (Sepolia, Arbitrum, Base, Fuji, Amoy, Monad — see `/v1/assets`) | inbound | Circle CCTP v2 burn-and-mint |
| `usdc-cctp-from-rome` | USDC | Rome | outbound | Circle CCTP burn-and-mint |
| `usdc-solana-to-rome` | USDC | Solana | inbound | SPL transfer via PDA-ATA |
| `usdc-solana-from-rome` | USDC | Rome | outbound | Atomic Rome tx to SPL destination |
| `eth-wormhole-to-rome` | ETH | Ethereum | inbound | Wormhole lock and mint wrapped ETH |
| `eth-wormhole-from-rome` | ETH | Rome | outbound | Rome approve + burn → Ethereum claim |
| `sol-solana-to-rome` | SOL | Solana | inbound | wSOL transfer + optional claim |
| `sol-solana-from-rome` | SOL | Rome | outbound | Atomic Rome tx (wSOL wrapper) |
| `spl-solana-to-rome` | SPL (any mint, incl. LSTs) | Solana | inbound | SPL transfer via PDA-ATA (`splAsset` selects the mint) |
| `spl-solana-from-rome` | SPL (any mint, incl. LSTs) | Rome | outbound | Mint-explicit Rome withdraw to an SPL destination |
| `token-wormhole-from-rome` | TOKEN (generic) | Rome | outbound | Wormhole egress for a generic token |

Outbound CCTP (`usdc-cctp-from-rome`) likewise reaches any catalog EVM destination via `destinationChainId`. The full machine-readable catalog is at `GET /v1/assets`, including per-route min and max amount limits.

---

## Endpoint reference

### `GET /v1/health`

Liveness probe.

**Response 200:**

```json
{
  "status": "ok",
  "version": "1.0.1",
  "attestation": {
    "circle":   { "status": "ok", "lastFetchAgeSeconds": null, "upstream": "iris-api.circle.com" },
    "wormhole": { "status": "ok", "lastFetchAgeSeconds": null, "upstream": "api.wormholescan.io" }
  }
}
```

`status: "ok"` means the API process is up. `attestation.<provider>.status` reflects whether the API has been able to reach the attestation provider recently. `lastFetchAgeSeconds: null` means no fetch has happened yet in the current process lifetime.

---

### `GET /v1/assets`

Returns the static route matrix.

**Response 200:**

```json
{
  "routes": [
    {
      "key": "usdc-cctp-to-rome",
      "asset": "USDC",
      "direction": "to-rome",
      "sourceChain": "ethereum",
      "decimals": 6,
      "minAmount": "1000000",
      "maxAmount": "100000000000"
    },
    ...
  ]
}
```

`minAmount` and `maxAmount` are inclusive bounds in base units. The eight entries are the same as the [routes table above](#the-eight-routes).

---

### `GET /v1/chains`

Returns the Rome chains the API can quote against. Backed by a public chain registry; resolved with a 60-second in-process cache.

**Query parameters:**

| Param | Type | Required | Notes |
|---|---|---|---|
| `programId` | string (base58) | no | Restrict results to chains hosted by a specific rome-evm program. Default scope returns testnet + mainnet primaries. |

**Response 200:**

```json
{
  "chains": [
    {
      "chainId": "200010",
      "name": "Hadrian",
      "network": "testnet",
      "rpcUrl": "https://hadrian.testnet.romeprotocol.xyz/",
      "explorerUrl": "https://via-hadrian.testnet.romeprotocol.xyz/",
      "programId": "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
      "gasMintId": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      "gasSymbol": "USDC",
      "gasDecimals": 6
    },
    ...
  ]
}
```

**Errors:**
- `400 rome.bridge.program-id-unknown` — the `programId` query param doesn't match any registered program.

---

### `POST /v1/quote`

Builds the unsigned-transaction chain for a bridge. **Stateless** — does not persist anything; safe to call repeatedly.

**Request body:**

```json
{
  "asset": "USDC",
  "direction": "to-rome",
  "sourceChain": "ethereum",
  "romeChainId": "200010",
  "amount": "1000000",
  "sender":  { "ethereum": "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
  "recipient": "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562"
}
```

| Field | Type | Notes |
|---|---|---|
| `asset` | `"USDC" \| "ETH" \| "SOL"` | The asset being bridged. |
| `direction` | `"to-rome" \| "from-rome"` | Inbound or outbound. |
| `sourceChain` | `"ethereum" \| "solana" \| "rome"` | Where the user's source funds are. |
| `romeChainId` | string | The Rome chain involved (target on inbound, origin on outbound). |
| `amount` | string (base units) | Between the route's `minAmount` and `maxAmount`. |
| `sender` | object | The user's address on each chain they'll sign on. Required keys depend on the route — see [Worked example](#worked-example-inbound-usdc-via-cctp). |
| `recipient` | string | The destination EVM address (inbound) or destination Solana / Ethereum address (outbound). |

**Response 200:**

```json
{
  "route": "usdc-cctp-to-rome",
  "direction": "to-rome",
  "amountIn":  "1000000",
  "amountOut": "1000000",
  "steps": [
    {
      "n": 1,
      "kind": "cctp-approve-and-deposit",
      "chain": "ethereum",
      "actor": "user",
      "status": "ready",
      "unsignedTxs": [
        { "to": "0x...", "data": "0x095ea7b3...", "value": "0" },
        { "to": "0x...", "data": "0x9b049b3b...", "value": "0" }
      ]
    },
    {
      "n": 2,
      "kind": "cctp-receive-message",
      "chain": "solana",
      "actor": "sponsor",
      "status": "blocked"
    },
    {
      "n": 3,
      "kind": "settle-inbound-bridge-sponsored",
      "chain": "solana",
      "actor": "sponsor",
      "status": "blocked"
    }
  ]
}
```

Each `step` has:

| Field | Notes |
|---|---|
| `n` | 1-indexed sequence number. Use this in the step-broadcast endpoint. |
| `kind` | Stable identifier for the step's bridge primitive (e.g. `cctp-approve-and-deposit`). |
| `chain` | Where the step's transaction lands (`ethereum`, `solana`, or `rome`). |
| `actor` | Who signs and broadcasts — `user`, `sponsor`, or `relayer`. Only `user` steps require integrator action. |
| `status` | `ready` if the step can be broadcast immediately. `blocked` if it depends on a prior step or an attestation. |
| `unsignedTxs` | Present on `actor: "user"` steps. An array of unsigned tx payloads the user signs in sequence. |

**Errors:**
- `400 rome.bridge.recipient-invalid` — malformed request body.
- `400 rome.bridge.asset-not-supported` — `(asset, direction, sourceChain, romeChainId)` does not resolve to a supported route.
- `400 rome.bridge.amount-out-of-range` — amount outside route's min/max.

---

### `POST /v1/transfers`

Registers a transfer after the user has broadcast step 1. The API verifies the on-chain source tx matches the quote.

**Request headers:**

| Header | Required | Notes |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `Idempotency-Key` | no | Caller-supplied key for retry safety. Same key within 24h → same record returned. Case-insensitive header name. |

**Request body:**

```json
{
  "quote":        <full quote object from POST /v1/quote>,
  "step1TxHash":  "0xab12...cd34"
}
```

The full `quote` from the prior `POST /v1/quote` call is required — the API verifies the on-chain step-1 transaction matches the quote's step 1 by equality: `{to, selector, full calldata including recipient bytes, value}`. Any mismatch is a hard fail (`rome.bridge.source-tx-mismatch`).

**Response 200:**

```json
{
  "id": "txr_01J...",
  "route": "usdc-cctp-to-rome",
  "direction": "to-rome",
  "amountIn":  "1000000",
  "amountOut": "1000000",
  "sender": { ... },
  "recipient": "...",
  "outcome": "pending",
  "steps": [
    {
      "n": 1,
      "kind": "cctp-approve-and-deposit",
      "status": "submitted",
      "txHashes": ["0xab12...cd34"]
    },
    {
      "n": 2,
      "kind": "cctp-receive-message",
      "status": "blocked"
    },
    {
      "n": 3,
      "kind": "settle-inbound-bridge-sponsored",
      "status": "blocked"
    }
  ]
}
```

**Idempotency.**

- *Natural key* (always active): `(romeChainId, step1TxHash)`. Submitting the same source-tx hash twice returns the same transfer record.
- *Caller-supplied* (optional): `Idempotency-Key` request header. The API returns the same record for any `POST /v1/transfers` carrying that header within a 24-hour window. Useful for retries before `step1TxHash` is known (e.g. the user's wallet broadcast succeeded but the API response was lost — re-send with the same `Idempotency-Key` and you'll see the same record on the second attempt).

Either path is safe to retry on network failures.

**Errors:**
- `400 rome.bridge.recipient-invalid` — malformed request body.
- `404 rome.bridge.source-tx-not-found` — the on-chain tx for `step1TxHash` couldn't be found.
- `400 rome.bridge.source-tx-mismatch` — on-chain tx does not match the quote's step 1.
- `410 rome.bridge.quote-expired` — the quote is no longer valid (re-quote).

---

### `GET /v1/transfers`

List a user's transfers. Indexed by every address that appeared on the transfer's `recipient` or `sender.{ethereum,solana,rome}` field at create time.

**Query parameters:**

| Param | Type | Required | Notes |
|---|---|---|---|
| `address` | string | yes | EVM (0x…) or Solana (base58) address. Case-insensitive. |

**Response 200:**

```json
{
  "transfers": [
    { "id": "txr_01J...", "route": "usdc-cctp-to-rome", "outcome": "complete", ... },
    { "id": "txr_02K...", "route": "eth-wormhole-to-rome", "outcome": "pending", ... }
  ]
}
```

Each entry is a full transfer record (same shape as `GET /v1/transfers/{id}`). Empty array if no matches.

**Errors:**
- `400 rome.bridge.recipient-invalid` — `address` query parameter missing. The API refuses unbounded listing.

---

### `GET /v1/transfers/{id}`

Returns the current state of a transfer.

**Response 200:** Same shape as `POST /v1/transfers`. Step statuses advance as upstream attestations arrive and sponsor-driven steps confirm.

The recommended polling cadence is **5 seconds** for inbound transfers (CCTP attestations typically take 10-30 seconds; Wormhole guardian signing typically takes ~15 minutes on testnet, faster on mainnet).

**Errors:**
- `404 rome.bridge.source-tx-not-found` — no transfer with that id.

---

### `POST /v1/transfers/{id}/steps/{n}`

Reports that a user has broadcast a follow-up step (steps 2+, when `actor: "user"`). Step 1 is reported via `POST /v1/transfers`.

**Request body:**

```json
{
  "txHash":      "0xfe98...76ba",
  "broadcastAt": "2026-05-22T10:30:00Z"
}
```

**Response 200:** Updated transfer record with the step advanced from `ready` to `submitted`.

**Errors:**
- `404 rome.bridge.source-tx-not-found` — transfer or step not found.
- `409 rome.bridge.step-not-ready` — step is not in `ready` state (e.g. still `blocked`, or already `submitted`).

---

## Transfer lifecycle

Every transfer has an `outcome` field at the top level and per-step `status` fields. Walk the state machine until `outcome` is terminal.

**Top-level `outcome`:**
- `pending` — at least one step is still active.
- `complete` — every step has reached a terminal state.
- `expired` — the quote validity window elapsed before completion.

**Per-step `status`:**
- `blocked` — depends on a prior step or an upstream attestation. Not actionable by the user.
- `ready` — actionable. If `actor: "user"`, the user can sign and broadcast.
- `submitted` — the step's transaction has been broadcast but is not yet confirmed.
- `confirmed` — the step's transaction has confirmed on its chain.

**State transitions:**

```
blocked  ─►  ready  ─►  submitted  ─►  confirmed
```

A step never moves backwards. Once `confirmed`, it stays `confirmed`.

**When does `blocked` advance to `ready`?**

| Step kind | Trigger for ready |
|---|---|
| `cctp-receive-message` | Circle attestation becomes available |
| `wormhole-complete-transfer-wrapped` | Wormhole VAA becomes available |
| `settle-inbound-bridge-sponsored` | The prior receive step has confirmed |
| Any other step | Prior step has confirmed |

The API's attestation poller fetches Circle and Wormhole attestations in the background (5-second tick) and advances steps automatically. Integrators don't need to fetch attestations themselves.

---

## Error reference

All errors use the same shape:

```json
{
  "code":   "rome.bridge.source-tx-mismatch",
  "title":  "Source tx mismatch",
  "status": 400,
  "detail": "on-chain tx does not match quote step 1: to mismatch (expected 0xABC..., got 0xDEF...)",
  "meta":   {}
}
```

Catalog:

| Code | HTTP | When it's returned |
|---|---|---|
| `rome.bridge.asset-not-supported` | 400 | `(asset, direction, sourceChain, romeChainId)` does not resolve to a supported route. |
| `rome.bridge.amount-out-of-range` | 400 | `amount` is below `minAmount` or above `maxAmount` for the route. |
| `rome.bridge.recipient-invalid` | 400 | Malformed request body or invalid recipient address. |
| `rome.bridge.sender-incomplete` | 400 | `sender` is missing the address for a chain the route needs to sign on. |
| `rome.bridge.source-tx-not-found` | 404 | The on-chain source tx (or transfer id) couldn't be found. |
| `rome.bridge.source-tx-mismatch` | 400 | On-chain source tx does not match the quote's step 1. |
| `rome.bridge.attestation-not-ready` | 425 | Caller queried a step that depends on an upstream attestation that hasn't arrived. |
| `rome.bridge.step-not-ready` | 409 | Step is not in `ready` state for the broadcast endpoint. |
| `rome.bridge.step-tx-mismatch` | 400 | Step's reported `txHash` does not match the step's expected unsigned tx. |
| `rome.bridge.step-expired` | 410 | Step's validity window elapsed. |
| `rome.bridge.quote-expired` | 410 | Quote has expired since it was issued. |
| `rome.bridge.chain-id-ambiguous` | 409 | The same `chainId` is registered across multiple rome-evm programs; caller must disambiguate via `programId` query. |
| `rome.bridge.program-id-unknown` | 400 | `programId` query parameter is not a registered program. |
| `rome.bridge.rate-limited` | 429 | Caller is making too many requests. |

Clients should:
- Branch on `code`, not on `title` or `detail` (those may evolve).
- Treat unknown `code` values as failures — never assume success on an unfamiliar code.
- Retry on `429` with exponential backoff; respect `Retry-After` if present.
- Re-quote on `quote-expired` / `step-expired` rather than retrying the same call.

---

## Worked example — inbound USDC via CCTP

End-to-end flow for bridging 1 USDC from Ethereum Sepolia into a Rome chain (chainId `200010`) using CCTP.

### Step 1 — quote

```bash
curl -X POST https://<bridge-api-host>/v1/quote \
  -H "Content-Type: application/json" \
  -d '{
    "asset": "USDC",
    "direction": "to-rome",
    "sourceChain": "ethereum",
    "romeChainId": "200010",
    "amount": "1000000",
    "sender":    { "ethereum": "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562" },
    "recipient": "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562"
  }'
```

The response includes three steps:

1. `cctp-approve-and-deposit` — `actor: "user"`, two unsigned Ethereum txs (USDC approve + CCTP `depositForBurn`). Status `ready`.
2. `cctp-receive-message` — `actor: "sponsor"`. Status `blocked`. The bridge sponsor will broadcast this on Solana once Circle's attestation is available.
3. `settle-inbound-bridge-sponsored` — `actor: "sponsor"`. Status `blocked`. The bridge sponsor will broadcast this on Solana once step 2 confirms.

### Step 2 — user signs and broadcasts step 1

The user signs both Ethereum txs from `steps[0].unsignedTxs[]` in order. Save the second tx's hash (the `depositForBurn` call) — that's `step1TxHash`.

### Step 3 — register the transfer

```bash
curl -X POST https://<bridge-api-host>/v1/transfers \
  -H "Content-Type: application/json" \
  -d '{
    "quote":       <full quote object from step 1>,
    "step1TxHash": "0xab12...cd34"
  }'
```

The API verifies the on-chain `depositForBurn` matches the quote's step 1 (full calldata equality on `{to, selector, args, value}`) and creates a transfer record. Note the response's `id` field — that's your handle for the rest of the flow.

### Step 4 — poll for completion

```bash
curl https://<bridge-api-host>/v1/transfers/<id>
```

Poll every 5 seconds. Watch the steps advance:

- step 1: `submitted` → `confirmed` (after a few Ethereum blocks)
- step 2: `blocked` → `ready` → `submitted` → `confirmed` (after Circle attestation, ~10-30s)
- step 3: `blocked` → `ready` → `submitted` → `confirmed` (immediately after step 2)

When `outcome` reaches `complete`, the user has 1 USDC of Rome chain `200010` gas credit.

### Total user signatures

The user signs **step 1's two source-chain txs** — plus, on **gas-intent CCTP inbound**, one off-chain **EIP-712 `SettleAuthorization`** (returned in the quote's `signatureRequests`; the client fills `sourceTxHash` from the burn tx and passes the signature as `userSettleSig` to `POST /v1/transfers`). That signature is what makes the sponsored settle trustless: the sponsor can only execute the settle the user authorized, to the recipient the signature commits to. Steps 2 and 3 are sponsored — no user signatures on-chain, no user gas.

---

## Glossary

**Asset.** One of `USDC`, `ETH`, `SOL`, `SPL` (any SPL mint, selected with `splAsset`), or `TOKEN` (generic Wormhole egress).

**Direction.** `to-rome` (inbound, lands on a Rome chain) or `from-rome` (outbound, leaves a Rome chain).

**Route.** A specific bridge mechanism for an `(asset, direction, sourceChain)` triple. There are eleven; see [The route catalog](#the-route-catalog).

**Step.** A single transaction in a route. Some routes have 1 step; some have 3. Each step has an `actor` — the entity that signs and broadcasts it.

**Step kind.** Stable identifier for what a step does (e.g. `cctp-approve-and-deposit`, `wormhole-wrap-and-transfer-eth`). Integrators rarely need to dispatch on this — the `unsignedTxs` field carries everything the user needs.

**Step actor.**
- `user` — the human / wallet driving the bridge. Signs `unsignedTxs`.
- `sponsor` — the bridge operator's worker. Submits Solana-side completion and settle transactions on the user's behalf.
- `relayer` — a third-party network (e.g. Circle CCTP, Wormhole guardians). The API watches these and advances steps when their attestations arrive.

**Quote.** The result of `POST /v1/quote`. Contains the chain of steps required to complete a bridge. Stateless — no transfer is created.

**Transfer.** The result of `POST /v1/transfers`. A persistent record of an in-flight bridge, addressable by `id`.

**Source-tx verification.** When you call `POST /v1/transfers`, the API verifies the on-chain step-1 transaction matches the quote's step 1 by full calldata equality. Any mismatch is a hard fail. This is the API's commitment to the integrator that what the user actually broadcast matches what they were shown.

**Sponsor.** A bridge-operator-controlled worker that signs and broadcasts Solana-side completion + settle transactions, so the user only signs the source-chain leg. The sponsor never holds custody; settle destinations are deterministically derived from the user's identity (PDA derivation from EVM address), so the sponsor cannot redirect funds.

**Attestation.** A cross-chain message authorizing the destination-chain release. CCTP attestations come from Circle's Iris service; Wormhole attestations come from the Wormhole guardian network.

**Gas mint.** The Solana SPL mint that a Rome chain treats as its native gas token. Bridging that mint inbound results in native gas credit for the user; bridging other mints results in wrapped SPL tokens on the Rome chain.
