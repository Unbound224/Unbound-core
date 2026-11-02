# Unbound — Technical Build Guide (AI-agent source of truth)


# Recommended stack and scaffolding

- Mobile: Flutter stable / Dart 3, Riverpod for app state, go_router for navigation, secure keystore/keychain, integration_test on real devices.
- Web: Next.js 16 / React / TypeScript / Tailwind; do not hard-code a final look. Responsive, accessible and measured.
- API: Node.js 24 LTS / NestJS / PostgreSQL / Prisma / Redis + BullMQ, OpenAPI 3.1, Zod at boundaries.
- Stellar adapters: TypeScript with current compatible `@stellar/stellar-sdk`; native Horizon path/order-book functions for Unbound, Soroban RPC/contracts for Torrent/Sideband.
- Indexing: cursor-based ledger polling with backfill/replay, confirmations, dedup, deterministic recovery from missed events.
- Contracts: Rust stable + matching Soroban SDK/Stellar CLI protocol versions; local sandbox -> Testnet; security review before Mainnet.
- Dev infra: Docker Compose for local DB/Redis, `.env.example`, GitHub Actions (format/lint/test), typed generated client schemas, test fixtures.
- Versioning policy: lockfiles checked in. Pin actual patch versions after initial reproducible build, rather than inventing version numbers now.
- Secrets: NEVER in Git, CI logs, client code, generated demos, documentation examples with valid keys, or screenshots.


# Cross-repository contract

- One repo = one independent engineering ownership boundary, not one artificially split folder.
- Application clients never control authoritative financial state or store server signing keys.
- One authoritative backend owns identity, application access policy and audit; chain-facing repos own ledger interpretation/transaction tooling; no overlapping writers.
- Separate on-chain truth from off-chain projections. Recovery and reconciliation are first-class.
- Financial operations use idempotency keys and explicit state transitions (`CREATED`, `AUTHORIZED`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `RECONCILING`).
- Never show a transaction as settled before the expected finality proof is observed.
- Specify exact data provenance, network passphrases, issuer addresses and contract addresses; no invented partner integrations.
- Every amount uses integer minimal units or arbitrary-precision decimals, never binary floats.
- No real-money or production promises in MVP. Default to Stellar Testnet and dummy merchants/assets/providers.
- Version every message schema and API contract. Any breaking change requires coordinated PRs and an integration test.
- Architecture is fixed for ownership, while UI design direction is intentionally revisable.
- Design decisions may evolve with an ADR inside the affected repo; update cross-repo interfaces when they do.
- Never fabricate user activity, prices, payout rights, liquidity, provider status, or app-store availability.
- A repo is Wave-worthy only if it has independently meaningful tests, release artifacts, issues and contributors, not because of its name.


## Scaffolding and repo paths
### `unbound-mobile` — Flutter mobile
- Responsibility: Consumer asset inventory, issuer discovery, offers, approvals, wallet/secure signing, redemption status, transaction receipts
- Suggested bootstrap: `flutter create --platforms=android,ios unbound_mobile` (then adopt repo root; Riverpod, go_router, secure storage and signed wallet adapter)
- Proposed top-level directories: `lib/{app,features,domain,integrations,design_system}/, test/, integration_test/, android/, ios/`
- Required before any feature: typecheck/lint/test, `.env.example`, security-first README, generated schema/version contracts and synthetic fixtures.

### `unbound-core` — NestJS backend
- Responsibility: Merchant onboarding, verified issuer/redemption policies, listings and reservations, user accounts, authorization, canonical operational data, dispute workflow
- Suggested bootstrap: `pnpm dlx @nestjs/cli new . --strict` then add Prisma, PostgreSQL, BullMQ and OpenAPI
- Proposed top-level directories: `src/{modules,auth,persistence,integrations,common}/, prisma/, test/, scripts/`
- Required before any feature: typecheck/lint/test, `.env.example`, security-first README, generated schema/version contracts and synthetic fixtures.

### `unbound-stellar` — TypeScript Stellar-native SDK + chain worker
- Responsibility: Native Stellar asset issuance integration, account trustlines, issuer flags, order-book/path quoting, transactions, indexing/reconciliation, typed integration SDK
- Suggested bootstrap: `pnpm init` + TypeScript; add Stellar SDK, durable cursors, test fixture generator
- Proposed top-level directories: `src/{rpc,ledger,indexer,quotes,types}/, tests/, scripts/, generated/`
- Required before any feature: typecheck/lint/test, `.env.example`, security-first README, generated schema/version contracts and synthetic fixtures.

### `unbound-site` — Next.js marketing + merchant portal
- Responsibility: Public consumer landing, official store badges, merchant issuer console, merchant redemption operations, docs and partner onboarding
- Suggested bootstrap: `pnpm create next-app@latest . --ts --tailwind --eslint --app --src-dir`
- Proposed top-level directories: `src/app/, src/components/, src/features/, src/lib/api/, public/brand/, tests/e2e/`
- Required before any feature: typecheck/lint/test, `.env.example`, security-first README, generated schema/version contracts and synthetic fixtures.

## Development stages and exact phase gates

**M0 — Contract-first planning (all repos).** Freeze API events/payloads, chain addresses/versions, DB ownership, demo story and test fixtures. README must state connected siblings and local startup commands.

**M1 — Protocol proof.** Produce a minimal local/Testnet transaction across the Stellar-dependent engine with independent tests. No product UI polish required. Explicitly demonstrate what cannot work without Stellar.

**M2 — Authoritative backend.** Implement persistent domain state, identity, validation, permissions, API docs, queues, reconciliation and safe failure states.

**M3 — Frontend/device vertical slice.** Build one end-to-end flow consuming the real M1/M2 code. Test mobile on devices where applicable; for web, add accessible route/state tests.

**M4 — Operability.** Diagnostics, documentation, test coverage, security review, backup/recovery, monitoring, rate limits, token/cost safety.

**M5 — Release candidate.** Repeatable demo from fresh clone, audited build provenance, no false status claims, responsible Open Source issue backlog.

## Required deliverables per repo
- Functional implementation and independent test runner;
- generated OpenAPI/JSON schema or ABI/bindings for its public boundary;
- local setup + clean shutdown + deployment instructions;
- telemetry, failure/retry patterns and synthetic fixtures;
- changelog/release tags, contribution guidance and typed dependencies;
- CI with tests and security scans;
- an E2E demonstrated use of the subsystem by at least one sibling repo.

## External research and upstream dependencies
- [Stellar assets](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets) — verify license/API compatibility before adopting.
- [Stellar SDK](https://github.com/stellar/js-stellar-sdk) — verify license/API compatibility before adopting.
- [Stellar Docs](https://developers.stellar.org/) — verify license/API compatibility before adopting.
- Never use a sample asset as if it were a live merchant-issued liability. Partnership/issuer and liquidity are part of the product, not optional decorations.
