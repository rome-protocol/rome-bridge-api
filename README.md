# rome-bridge-api

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.

A **stateless HTTP API** that wraps Rome's bridge primitives — Circle CCTP, Wormhole, and Solana SPL flows — behind a small REST surface for integrators. It is the bridge's **off-chain orchestrator and fee-sponsor**, not a fund-custodying bridge: **the API process holds no on-chain keys**, and the sponsor worker is fee-payer-only (it can trigger a user's own signed intent, never move funds).

The real bridge is **on-chain** — `RomeBridgeWithdraw` (egress) and the Rome EVM's `settle_inbound_bridge` (inbound credit, authorized by a user-signed EIP-712 intent), plus Circle CCTP / Wormhole for transport. This service quotes routes, verifies source transactions, and sponsors the gas to land them.

This repository is the **API only** — there is no bundled UI. Build your own front-end against the REST surface, or use it server-to-server.

## Quick start

```bash
npm ci
npm run build
# minimum env (see .env.example for the full list):
#   REDIS_URL=redis://localhost:6379
#   REGISTRY_PATH=/path/to/a/clone/of/rome-protocol/rome-registry
#   ETHEREUM_RPC_URL=https://sepolia.infura.io/v3/<your-key>
npm start        # listens on :3000
```

Chain metadata is **registry-driven** — nothing is hard-coded. Point `REGISTRY_PATH` at a local clone of the public [`rome-protocol/rome-registry`](https://github.com/rome-protocol/rome-registry) (or let the client fetch it from GitHub). The service refuses to boot without it.

## API surface

All endpoints are under the `/v1` prefix. Full reference — request/response shapes, the error catalogue, and a worked example — is in [`docs/API.md`](docs/API.md).

| Endpoint | Purpose |
|---|---|
| `POST /v1/quote` | Quote a route (USDC / ETH / SOL / SPL / TOKEN; in- or out-bound) |
| `POST /v1/transfers` | Register a source tx; poll its lifecycle |
| `GET /v1/transfers/{id}` | Transfer status + next step |
| `GET /v1/assets` | Concrete fixed-asset routes |
| `GET /v1/chains` | Supported chains (registry-derived) |
| `GET /v1/tokens` | Supported tokens |
| `GET /v1/solana/*` | Solana-side helpers |
| `GET /v1/openapi.json` | OpenAPI document |

## How it works

- **No custody** — the API holds no keys; the sponsor worker is a fee-payer and can only *trigger* what a user's on-chain signed intent already authorizes.
- **Trustless inbound settle** — inbound credit is enforced in-program against a user-signed EIP-712 authorization, so any caller (the sponsor) can submit without being trusted.
- **Registry-driven** — chains, contract addresses, and bridge wiring resolve from the public registry.

Architecture, the trustless-settle rationale, and the invariants are in [`docs/BRIDGE_API_ARCHITECTURE.md`](docs/BRIDGE_API_ARCHITECTURE.md).

## Learn more

- **[Rome Protocol documentation](https://docs.rome.builders)** — how EVM execution and CPI work inside Solana.
- See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.
- The on-chain egress contract lives in [rome-solidity](https://github.com/rome-protocol/rome-solidity) (`RomeBridgeWithdraw`).
