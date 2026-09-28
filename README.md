# OpenSea ACO Bot

Low-latency NFT minting bot that monitors OpenSea drops and executes eligible
mints automatically through the **official OpenSea API** — no scraping, no
CAPTCHA bypassing, no rate-limit circumvention.

## Status: Phase 1 complete

| Phase | Scope | State |
|---|---|---|
| 1 | Backend, config, OpenSea integration, drop monitor, dry-run executor | ✅ done |
| 2 | Wallet/signing + real submission | ✅ included (gated by `DRY_RUN`) |
| 3 | Low-latency monitoring, RPC failover, nonce mgmt, tx monitoring | ✅ included |
| 4 | Dashboard | 🟡 scaffold (live overview page) |
| 5 | Discord/Telegram notifications | ✅ included |
| 6 | Postgres persistence, Docker, hardening | 🟡 DDL + compose included |

## Architecture

```
strategies.yaml ──► @aco/config ──► AcoBot (apps/api)
                                      │
        ┌─────────────────────────────┼──────────────────────────┐
        ▼                             ▼                          ▼
 @aco/monitoring              @aco/opensea                 @aco/blockchain
 DropMonitor (adaptive        OpenSeaClient (keep-alive,   ChainClients (viem,
 polling, stage detection)    token-bucket rps, retries)   multi-RPC fallback)
        │ mint:live                                                │
        ▼                                                          ▼
 @aco/executor ────────────────────────────────────────────────────
 MintExecutor: validate → build → simulate → sign → broadcast → confirm
        │
        ▼
 @aco/database (AttemptStore) + @aco/notifications (Discord/Telegram)
```

Critical path: `mint:live` event → safety/condition checks →
`POST /api/v2/drops/{slug}/mint` → `eth_call` simulation → local
`signTransaction` → `sendRawTransaction` → `waitForTransactionReceipt`.
Every stage is timestamped (`ExecutionTrace`) and surfaced via
`GET /api/metrics/latency`.

## Install

```powershell
npm install
copy .env.example .env          # fill in OPENSEA_API_KEY
copy strategies.example.yaml strategies.yaml
npm test                        # vitest suite
npm run dev                     # API on :4000 (DRY_RUN=true by default)
# dashboard is served by the API itself — open http://localhost:4000
```

Docker: `docker compose up --build` (api + postgres + redis).

## Configuration

`.env` — secrets and global safety limits (see `.env.example`).
`strategies.yaml` — per-collection rules.

**Interactive setup:** `npm run dev` in a terminal launches a wizard
before monitoring starts — choose **self** or **clients**, paste an
OpenSea collection link, and it reports the mint time, your wallet's
eligibility, and the funding needed (price + gas vs. balance), then arms
the mint. Client mode registers a named wallet key for the session.
Wizard-added strategies live for the process only — add them to
`strategies.yaml` to persist. Set `ACO_WIZARD=false` to skip it.

```yaml
strategies:
  - collection: "example-drop"
    chain: "base"            # any OpenSea EVM chain — see below
    quantity: 1
    max_price: 0.05          # per-token ceiling, native units
    auto_mint: true
    max_attempts: 3
    conditions:
      require_public_mint: true
      max_gas_fee: 0.01      # per-tx gas ceiling
      stop_after_success: true
```

**Networks:** every OpenSea-supported EVM chain works — `ethereum`,
`base`, `polygon`, `arbitrum`, `arbitrum_nova`, `optimism`, `avalanche`,
`bsc`, `blast`, `zora`, `sei`, `ape_chain`, `abstract`, `berachain`,
`monad`, `unichain`, `ronin`, `flow_evm`, `somnia`, `hyper_evm`,
`soneium`, `ink`, `scroll`, `linea`, `mantle`, `taiko`, `zksync`,
`sonic`, `world_chain`, `swellchain`, `story`, `gnosis`, `celo`,
`moonbeam`, `fantom`, `cronos`, `zetachain`, `boba`, `klaytn`, `mint`,
`shape`, `morph`, `gravity`, `b3`, `gunz`, `xai`, `chiliz`, `cyber`,
`lisk`, `hemi`, `redstone`, `treasure`, `degen`, `ham`, `orderly`,
`superposition`, `sanko`, `hychain`, `arena_z`, `plume`, `lumia`,
`form`, `mode`, `fraxtal`, `zircuit`, `metis`, `opbnb`, `manta`,
`kroma`, `palm`, `polygon_zkevm`, `x_layer`, `xrp_evm`, `robinhood` —
plus any viem chain export name (including testnets like `base_sepolia`,
`robinhood_testnet`). Set
`RPC_<CHAIN>` in `.env` for each chain you use; unset chains fall back
to public RPCs. Non-EVM chains (e.g. Solana) are not supported.

**Cross-chain mints:** set `payment_chain` (and optionally
`payment_token`, default native) on a strategy or in `defaults` to pay
on a different chain than the drop lives on — e.g. keep funds on
Robinhood Chain and mint drops on any network:

```yaml
defaults:
  payment_chain: "robinhood"   # home chain — fund the wallet here
```

The executor calls `POST /drops/{slug}/cross_chain_mint`, signs and
submits the returned transaction legs in order on the payment chain,
then polls `POST /transactions/receipt` until the mint settles. The
payer needs balance on `payment_chain` only — no native token needed on
the drop's chain.

**Multiple wallets:** when a client's own wallet pays for their mints,
register each key as `PRIVATE_KEY_<NAME>` in `.env` and select it per
strategy with `wallet: "<name>"` (`PRIVATE_KEY` is `"default"`). The NFT
mints to that wallet's address and its key signs and pays gas — your
default key is untouched:

```yaml
- collection: "client-drop"
  wallet: "alice"    # uses PRIVATE_KEY_ALICE from .env
```

A strategy naming a wallet with no configured key logs a warning at boot
and skips at mint time.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | bot status, kill switch, dry-run, monitored collections |
| `GET /api/drops` | latest drop snapshots (stage, price, countdown) |
| `GET /api/strategies` | loaded strategy config |
| `GET /api/attempts` | recent mint attempts with latency traces |
| `GET /api/metrics/latency` | avg/p95 per stage + OpenSea API latency |
| `POST /api/mint/trigger` | run the pipeline manually for a collection |
| `POST /api/kill` / `POST /api/kill/release` | engage/release kill switch |
| `POST /api/monitor/:collection/pause|resume` | per-collection control |

## Safety model

- `DRY_RUN=true` (default): full pipeline, real OpenSea tx build, real
  `eth_call` simulation, local signing — but **never broadcasts**.
- Kill switch via env or `POST /api/kill`.
- Hard caps: per-tx spend, rolling 24h spend, gas fee, quantity.
- Contract verification: mint `to` must equal the drop's contract.
- Duplicate guard: one in-flight execution per (chain, collection, wallet);
  non-terminal attempts in the store also block resubmission.
- Retries only happen **before** broadcast; a broadcast with unknown
  result is marked `unknown`, never resent.
- `PRIVATE_KEY` stays in memory, is redacted from logs, and is never
  exposed via the API. Use a dedicated, minimally-funded hot wallet.

## OpenSea endpoints used

- `GET /api/v2/drops/{slug}` — stages, supply, `is_minting`
- `GET /api/v2/drops/{slug}/eligibility` — per-stage eligibility (wallet auth; degrades gracefully)
- `POST /api/v2/drops/{slug}/mint` — ready-to-sign `{to, data, value}`
- `GET /api/v2/drops` — discovery

All requests go through a shared token bucket (`OPENSEA_RPS`, default 4/s)
with `Retry-After`-aware backoff on 429/5xx.

## Tests

```powershell
npm test
```

Covers: config validation, stage detection, safety limits, the full
dry-run pipeline (price/quantity/balance/gas checks, contract
verification, simulation, duplicate protection, retry behavior), nonce
management, and the rate limiter.

## Roadmap

- Postgres `AttemptStore` (schema in `packages/database/schema.sql`)
- Multi-wallet registry with AES-256-GCM encrypted key storage
- Full dashboard pages (Drops / Strategy / Transactions)
- OpenSea Stream API subscription if/when drop events are exposed
