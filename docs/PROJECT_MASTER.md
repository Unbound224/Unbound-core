# Unbound — Master Context / Index

This is the full product context of the Unbound four-repo system. Docs are mirrored here to keep every repo standalone for coding agents. **The canonical maintained copy is in `unbound-core`.** Before merging breaking changes sync all mirrors via a script/CI.

# Unbound — Product Requirements Document

**Status:** technical product specification, preimplementation. **Platform:** Flutter mobile (iOS/Android) plus merchant/landing web.  **Target:** Stellar Testnet demo, real adoption only after risk/legal validation.

## Vision
An issuer-authorized marketplace for genuinely redeemable, transferable merchant credits. A user can receive digital store credit issued on Stellar and exchange it through native Stellar liquidity for another supported asset. The product does not magically convert an arbitrary gift card, nor promise liquidity or fiat withdrawal.

## Who needs it
Retailers or partners must opt in as issuers. Only verified, transferable and redeemable asset programs are supported.

## Core user outcomes
- issuer registry and legal redemption terms
- merchant-issued Stellar asset and trustline setup
- discover transferable credits, balances, value and redemption rules
- user-approved swap, slippage cap, quote expiry, settlement
- merchant redemption and burn/return procedure
- audit trail and safe transaction-state recovery

## Core customer journey
1. Issuer is verified and publishes authentic redemption terms for a transferable asset.
2. Merchant issues a supported sample credit on Stellar Testnet.
3. Holder sees actual credit, issuer identity, redemption obligations, trustline requirements.
4. Holder obtains a quote based on actual available path/order-book liquidity.
5. The user approves exact sell amount, minimum receive amount, fees, issuer risks, and signed transaction.
6. Stellar settlement is observed; balances and receipt reconcile.
7. Holder can also redeem supported credit with the participating merchant, following real issuer rules.

## Functional requirements
- issuer registry and legal redemption terms
- merchant-issued Stellar asset and trustline setup
- discover transferable credits, balances, value and redemption rules
- user-approved swap, slippage cap, quote expiry, settlement
- merchant redemption and burn/return procedure
- audit trail and safe transaction-state recovery

## Non-goals for first MVP
- convert every proprietary loyalty point or gift card
- instant bank withdrawals worldwide
- unlicensed custody or guaranteed secondary-market liquidity
- speculative credit token trading unrelated to real redemption

## Safety and commercial reality
- No issuer means no usable store credit. Never claim arbitrary voucher imports are cashable.
- Trustlines, asset flags, issuer authorization and revocation/clawback policies affect the user experience.
- Liquidity and slippage can prevent an exchange; quotes must expire and cannot be guaranteed.
- Bank-cashout requires licensed partners, and cross-border/consumer-credit rules differ by jurisdiction.

## Core success measures
- successful asset redemption percentage
- quote-to-settlement success
- settlement/reconciliation lag
- user fee+slippage disclosed vs charged
- verified issuer availability

## Acceptance tests
- Merchant can issue a sample redeemable credit on Testnet with documented terms.
- Buyer can establish required trustline and receive credit.
- A quoted trade shows all assets, issuer addresses, fees, slippage and expiry.
- A valid trade settles on Stellar Testnet and creates a reconciled receipt.
- No-liquidity/no-trustline/unauthorized asset routes fail safely without spending.
- Merchant can complete a simulated redemption and reconcile the asset movement.

## Repository architecture
See `ARCHITECTURE.md`. Exactly four repos are proposed as stable engineering ownership boundaries. Reducing or increasing them requires a written technical justification, not reward optimization.

---
# Unbound — Software Requirements & Domain Specification

## System boundaries
An issuer-authorized marketplace for genuinely redeemable, transferable merchant credits. A user can receive digital store credit issued on Stellar and exchange it through native Stellar liquidity for another supported asset. The product does not magically convert an arbitrary gift card, nor promise liquidity or fiat withdrawal.

### Domain objects (minimum initial schema)
- User: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- Merchant: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- IssuerVerification: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- AssetProgram: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- RedemptionPolicy: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- WalletBinding: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- CreditPosition: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- ExchangeQuote: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- ExchangeIntent: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- Settlement: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- RedemptionRequest: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- LedgerObservation: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields
- AuditEvent: UUID/opaque public ref + timestamps + status/metadata, no unverified external fields

### State transitions
- financial request/transaction: DRAFT -> VERIFIED -> AWAITING_SIGNATURE -> SUBMITTED -> CONFIRMED; failures go to FAILED or RECONCILING.
- authorization is evaluated server-side before signature requests.
- network confirmations trigger reconciliation; queued retries are idempotent and observable.
- ledger watchers must process duplicate events safely and replay historical ranges.

### Stable public API endpoints (v1 initial contract)
- POST /v1/merchants/apply
- GET /v1/assets?issuer=
- GET /v1/assets/:id
- POST /v1/wallets/challenge
- POST /v1/wallets/verify
- GET /v1/portfolio
- POST /v1/exchange/quote
- POST /v1/exchange/intents
- GET /v1/exchange/intents/:id
- POST /v1/exchange/intents/:id/submit
- POST /v1/redemptions
- GET /v1/redemptions/:id
- GET /v1/merchants/me/redemptions
- POST /v1/merchants/me/redemptions/:id/confirm

**Request/response convention:** JSON keys camelCase; public IDs opaque; `requestId` and `schemaVersion` included in asynchronous requests; error schema `{"error":{"code":"STRING_ENUM","message":"safe summary","requestId":"opaque"}}`. All writes requiring on-chain action return a stateful intent, not a fake immediate success. Produce OpenAPI documentation and integration fixtures before client implementation.

### Authoritative data ownership
- The main API owns users, policy, product workflow and off-chain financial obligations.
- The Stellar owner repo owns network adapters and ledger protocol semantics; do not duplicate transaction-building code in web/mobile.
- The user signs funds movement; server signing, if any, must use scoped secure keys and explicit sponsorship logic.
- Client caches are not accounting books.

### Failure modes to design first
- No issuer means no usable store credit. Never claim arbitrary voucher imports are cashable.
- Trustlines, asset flags, issuer authorization and revocation/clawback policies affect the user experience.
- Liquidity and slippage can prevent an exchange; quotes must expire and cannot be guaranteed.
- Bank-cashout requires licensed partners, and cross-border/consumer-credit rules differ by jurisdiction.
- repeated HTTP submit with same idempotency key -> exactly one business intent;
- chain timeout after submission -> RECONCILING, never assume failed or retry with changed parameters;
- stale quote / stale pool state / expired channel -> require new user approval;
- unrecognized network passphrase or issuer -> fail closed;
- disconnect / process crash -> resumable, replayable state;
- reconciliation discrepancy -> pause sensitive actions pending investigation.

### Performance baselines (engineering targets, not guarantees)
- local API reads p95 < 500ms under synthetic demo load;
- ledger confirmation times must reflect actual Testnet conditions, never a fixed animation;
- background jobs: retry bounded with dead-letter visibility;
- mobile poor-network state includes retry, offline read-only and recovery messaging;
- audit records capture actor, scope, action, time, object and request id, never secret keys.

### Security
- secure device key storage; no raw signing seeds in browser persistent storage;
- RBAC per role and resource; validated typed schemas for all inputs;
- TLS for network APIs, explicit local peer protocol auth for Sideband;
- no fake fiat settlement or institutional verification;
- rate limits, security logging without sensitive leakage, backup/restore, secret rotation;
- Testnet is default; Mainnet requires external review and compliance planning.

### QA
- domain state-machine unit tests; API integration tests; chain/sandbox end-to-end tests;
- on-chain amount and signature tests; invalid/missing auth; replay/rollback tests;
- client error/offline/permission tests; no secrets in builds;
- reproducible full product demo with documented assertions.

---
# Unbound — Cross-repository Architecture

## Why exactly four repositories?
These are four distinct deployable/reusable engineering domains. They must remain independently testable and publishable. Splitting arbitrary features into extra repos solely for Wave incentives is prohibited.

| Repository | Independent ownership | Outputs | Consumers |
|---|---|---|---|
| `unbound-mobile` | Consumer asset inventory, issuer discovery, offers, approvals, wallet/secure signing, redemption status, transaction receipts | Flutter mobile | product users or other repo services |
| `unbound-core` | Merchant onboarding, verified issuer/redemption policies, listings and reservations, user accounts, authorization, canonical operational data, dispute workflow | NestJS backend | product users or other repo services |
| `unbound-stellar` | Native Stellar asset issuance integration, account trustlines, issuer flags, order-book/path quoting, transactions, indexing/reconciliation, typed integration SDK | TypeScript Stellar-native SDK + chain worker | other project repos via versioned API/SDK |
| `unbound-site` | Public consumer landing, official store badges, merchant issuer console, merchant redemption operations, docs and partner onboarding | Next.js marketing + merchant portal | product users or other repo services |

## Request and ownership paths
```
Consumer Flutter -----> unbound-core <------ unbound-site merchant portal
                           |
                           v
                    unbound-stellar ------> Stellar assets, DEX, path payments
                           |
                           +-- indexed settlement state -> unbound-core
```
The mobile app does not own merchant verification, and the core API does not reimplement Stellar transaction algorithms. Site owns public marketing and merchant onboarding UI. The Stellar repo owns a reusable protocol SDK and watchers.

## Stellar integration: essential system, not decoration
- Native asset issuance: merchant issuance identity and redemption promise live off-chain, asset code+issuer on Stellar.
- Trustlines: consumer explicitly authorizes holding merchant-issued assets; issuer authorization flags respected.
- Native offers/order books and strict-send/strict-receive path payments produce actual conversion/settlement.
- Horizon/RPC reads and transaction history become verifiable ledger records; service indexer reconciles finality.
- Soroban is not needed for the core MVP. Introduce it only if a capability demonstrably requires contract logic.

## Service and package contracts
- OpenAPI for network APIs; generated Dart/TypeScript clients; schema snapshots checked into CI.
- Published package semver for reusable SDK/contract bindings; explicit peer version compatibility table.
- Idempotency tokens across all state-changing network/ledger operations.
- Reconciliation event contract: `{id, sourceRepo, schemaVersion, network, ledgerCursor, entityRef, status, observedAt}`.
- Never assume a wallet knows off-chain business rights or that an API database can overrule confirmed on-chain state.

## Integration test order
1. Each repository passes independent lint/build/unit tests.
2. Publish local SDKs and generated interfaces.
3. Run network local/sandbox or Testnet tests.
4. Run API/service orchestration tests with fake wallets and then test wallets.
5. Run frontend/device E2E.
6. Verify failure and recovery (network loss, duplicate event, stale authorization, partial settlement).

## Long-term release strategy
- Independent tags/releases in each repo.
- Project-wide integration lockfile references tested SHAs/tags of dependencies.
- Before shipping any release, each repo README links the matching version of its three siblings.

---
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

---
# Unbound — Threat Model / Trust & Safety

## Core assets to protect
- end-user wallet authorization and secrets;
- canonical ledger truth, quotes, settlement state, pool/channel collateral;
- merchant/provider or membership authority and representation;
- customer privacy, audit history, and safe account recovery.

## Threats and mitigations
- **Fake asset/issuer/provider** -> verify addresses/network and issuer/identity evidence, show issuer status and require explicit user confirmation.
- **Stale rate or condition** -> expiring quote/offer/maturity/channel state; revalidate before signature.
- **Transaction submitted but response lost** -> idempotent reconcile by stable tx hash; no blind double pay.
- **Replay or old signatures** -> domain separation, nonce/session ID, monotonic states, scoped expiry.
- **Key compromise** -> hardware-backed secure storage when available; rotate server secrets and support freeze/recovery flows.
- **Ledger indexing drift** -> process durable cursors, replay from known ledger, verify source and rehydrate read models.
- **Privacy leakage** -> do not put PII, contact data or commercial secrets into on-chain metadata or public source code.
- **Supply-chain attacks** -> pinned/reviewed dependencies, license inspection, security scanning, CI role separation.
- **Client manipulation** -> server validates authorization, user signs critical financial actions; clients not authoritative.

## Domain risks
- No issuer means no usable store credit. Never claim arbitrary voucher imports are cashable.
- Trustlines, asset flags, issuer authorization and revocation/clawback policies affect the user experience.
- Liquidity and slippage can prevent an exchange; quotes must expire and cannot be guaranteed.
- Bank-cashout requires licensed partners, and cross-border/consumer-credit rules differ by jurisdiction.

## Go-live restriction
MVP is Testnet/synthetic only. Prior to production or external real-money custody, obtain applicable legal/compliance review, security audit, incident response/insurance assessment, operational risk acceptance, verified issuer/provider integrations and UX consumer disclosures. Do not claim that a Stellar transaction alone establishes a valid real-world legal claim.

---
# Unbound — Approved Logo & Flexible Product Design

![Unbound logo](../brand/icon.svg)

**Logo approved as the project identity:** use `../brand/icon.svg` and `../brand/mark.svg` consistently. Do not revert to previously proposed placeholder logos.

**Approved palette:** primary `#7537F5`, background `#10092E`, light `#FBFAF8`; all fills are solid flat colors.

**Logo meaning:** Two distinct interlocking forms surround a shared opening, with a detached square representing value no longer trapped in one system.

**Design flexibility:** This approval is about the logo only. Claude or another build agent can improve UI, typography, layout, animation and information architecture; it must preserve financial truth and accessibility.

---

## Interface principles
- Financial truth comes before animation. Always show recipient/issuer, asset/currency, quoted rate, network, fees, authorization, and settlement state precisely.
- No fake 'approved' ticks or unverified trust claims.
- Include skeleton, empty, partial-confirmation, failure, retry, and low-connectivity states.
- Provide dark and light themes; respect reduced-motion preferences.
- Motion can be sophisticated but cannot delay important actions or disguise pending money.

## Mobile app store landing requirements
- Consumer download landing lives in `unbound-site`; merchant console and content live there too.
- Use official Apple App Store badge from https://developer.apple.com/app-store/marketing/guidelines/ and official Google Play badge per Google brand rules.
- Do NOT show linked download actions as active until a real app URL exists. Use “Coming soon” without inventing App Store or Play Store links.
- Badge artwork is third-party property; do not redraw or recolor it. Keep platform badges outside the original Unbound logo assets.

---
# Unbound — Implementation Roadmap & Quality Gates

- Merchant can issue a sample redeemable credit on Testnet with documented terms.
- Buyer can establish required trustline and receive credit.
- A quoted trade shows all assets, issuer addresses, fees, slippage and expiry.
- A valid trade settles on Stellar Testnet and creates a reconciled receipt.
- No-liquidity/no-trustline/unauthorized asset routes fail safely without spending.
- Merchant can complete a simulated redemption and reconcile the asset movement.

## Milestones
M0. Four GitHub repos exist under one organization; readmes and versioned API/ABI plan checked in. All repos have meaningful independent deliverables.

M1. Stellar-native protocol slice proven on Local/Testnet with reproducible transaction hashes and failure tests.

M2. Persistent service, API, reconciliation and identity layer with synthetic fixtures, migrations and observable jobs.

M3. Mobile/web UI working with real M1/M2 integration, including offline/error/retry states.

M4. Reliability: chain lag/replay, permission revocation, transaction idempotency, security review, key-management, data export.

M5. Release readiness: comprehensive README and onboarding, CI green, reproducible E2E from clean checkout; collect product feedback.

## Wave contributor lanes
- Repo-specific open issues only after a minimal working foundation exists.
- Each issue has motivation, target repo, interface touchpoints, acceptance tests, complexity and non-goals.
- Do not manufacture duplicated repos, duplicate work or fake contributions.
- Do not claim approval, future earnings or fixed Wave schedules.


# Wave preparation and execution

Before requesting a Stellar Wave listing:
1. Implement an actual vertical slice, not only documentation or placeholder code.
2. Ensure all repos are public, substantive, licensable, tested and actively maintained.
3. Split public contributor issues along the **real** repo boundaries described in ARCHITECTURE.
4. Issues must be specific, appropriately sized and testable. Do not fabricate meaningless tasks to increase repo count or rewards.
5. Set up GitHub labels (good first issue, bug, documentation, stellar, blocked) and PR templates.
6. Onboard each organization using the Drips maintainers flow, install the Drips GitHub App, sync repos and apply (subject to approval and per-user/per-org limits).
7. A shared maintainer application limit may prevent submitting 12 repos in a single Wave cycle. Do not assume approval or payment.

Official: https://docs.drips.network/wave/maintainers/participating-in-a-wave/
Limits: https://docs.drips.network/wave/maintainers/repo-application-limits/


---
# Unbound — Stellar Protocol and Financial Data Contracts

## Why native Stellar (not a generic Soroban escrow)
The credit itself is a classic Stellar issued asset `(asset_code, issuer_account)`; users establish trustlines and exchange assets using classic Stellar orderbook/path-payment primitives. The ledger is the settlement and transferable-credit substrate; there is no custom Unbound token required for MVP.

### Mandatory issuer contract (off-chain real-world agreement)
For each asset the backend must store an independent, human-readable, signed redemption policy: issuer legal identity + verification, asset code + issuer public key, unit-of-account meaning, face-value/redemption limitations, expiry, jurisdiction, refund/cancellation policy, contact information and KYC requirements. Issuer's permission to tokenize and transfer credits must be affirmative. A Stellar asset is **not** evidence that a shop will redeem it; legal identity & operational history require separate review.

### Native workflow
1. Verified merchant publishes an AssetProgram in `unbound-core`; Stellar adapter checks asset flags/account configuration and issuer trust.
2. Issuer creates a real Testnet credit asset and distributes a sample position to a user with the proper trustline; asset precision fixed at 7 decimal places on classic Stellar (use integer stroops-like base units).
3. Consumer requests sell asset and target asset; `unbound-stellar` queries actual path/offer liquidity; returns a **time-bounded indicative quote** including source/destination issuer addresses, network fees, `minDestinationAmount` or `maxSourceAmount`, liquidity depth, explicit slippage cap, and warning if no path exists.
4. `unbound-core` returns an unsigned transaction XDR (or safe wallet signing description) without ever requesting the user's secret key. User reviews exactly what they sign.
5. Broadcast and reconcile by transaction hash. A timed-out HTTP request after broadcast remains `RECONCILING`, not failed.
6. On success, buyer receives target supported asset and the ledger-derived receipt shows exact amounts. Merchant redemption uses a separate verified flow and may require returned/burned credit.

### Quote/intent request
```json
{
  "schemaVersion": "1.0",
  "sourceAsset": {"code":"SHOP","issuer":"G_TESTNET_ISSUER_PUBLIC_KEY"},
  "targetAsset": {"code":"USDC","issuer":"G_TESTNET_TARGET_ISSUER"},
  "sourceAmount": "80.0000000",
  "minimumDestinationAmount": "72.0000000",
  "slippageBps": 100,
  "destinationAccount": "G_TESTNET_USER_PUBLIC_KEY",
  "network": "TESTNET"
}
```
Values are **illustrative**, not actual quotes or usable addresses. Contract validation must reject untrusted issuers, unsupported assets, expired quotes, invalid amounts, missing trustlines and unapproved routes.

### Settlement observability
- Transaction lifecycle: `CREATED → QUOTED → USER_APPROVED → SUBMITTED → CONFIRMED` or `RECONCILING/FAILED/CANCELLED`.
- Key fields: `networkPassphrase`, `assetCode`, `issuer`, `amountIn`, `minOut`, `amountOutActual`, `sequence`, `memo`, `txHash`, `ledger`, `observedAt`, `reconciliationVersion`.
- Deduplicate by network + hash and classify failed path payments separately from submitted-but-unobserved.
- Secrets never flow from mobile to backend. Fee sponsorship must be explicit, not promised by default.

### Tests
- untrusted issuer rejected;
- trustline missing or unauthorized → blocked;
- insufficient native DEX liquidity → no quote;
- minimum output violation → transaction fails safely;
- quote expiration before signature → request new approval;
- duplicate submit idempotent;
- redemption of unsupported credit → unavailable, never fake cash-out.

---
# UX Routes & Brand Delivery (implementation brief, not locked art direction)

## Primary experience map
1. Onboarding / wallet & network verification
2. Explore supported merchant credits
3. Position detail with issuer redemption rights
4. Asset quote with full issuer, fees and slippage disclosure
5. Confirm & sign exact transaction
6. Status: submitted/reconciling/settled/failed
7. Redemption instructions and receipts
8. Security and trusted issuer settings

## Landing / discoverability
`unbound-site`: expressive but credible marketing home, product explainer, trust/issuer disclosure, supported merchant catalog, FAQ, security policy, official Apple/Google badges only once listings exist; authenticated merchant console with issuance support, redemption queue and audit logs.

## Interaction rules
- Do not imply a payment finalized until Stellar confirms it.
- Prefer one unmistakable primary CTA and clear financial disclosure over experimental visual gimmicks.
- Accessibility: keyboard and screen-reader semantics on web, reduced motion, useful focus, large tap targets on mobile.
- All transitions, fonts, layouts and hero art are open to revision by the building/design agent, with explicit design review.
- Official store badge guidance: https://developer.apple.com/app-store/marketing/guidelines/ and Google Play brand resources. Do not recreate the vendor badges with generative art.

---
# Unbound — Environment, Deployment and Recovery

## Environment boundaries
- Local: deterministic Docker Compose services, Stellar local network/Testnet, synthetic users/fixtures.
- Staging: separate database, bucket, API credentials, signing identities, Testnet assets/contracts, observability.
- Production: requires security audit, real issuer/provider agreements and relevant jurisdictional legal/compliance review. Not included in preimplementation scaffold.

## Suggested variables (non-secret examples only)
```dotenv
APP_ENV=development
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
DATABASE_URL=postgresql://localhost:5432/unbound
REDIS_URL=redis://localhost:6379
API_BASE_URL=http://localhost:3001
CHAIN_START_LEDGER=0
LOG_LEVEL=info
```
- Credentials to sign on-chain go into a secure secret manager or hardware-backed user wallet, never into a public mobile/web bundle.
- Signed store badge links are configured after actual publication; no fabricated App Store or Google Play app URLs.

## CI & GitHub setup
- GitHub Actions per repo: formatting/lint, schema checks, unit tests, dependency scanning; chain/devices smoke tests where supported.
- Branch protection and PR review recommended.
- Release tag points to tested sibling versions in an integration lockfile.
- All paths use offline/synthetic test fixtures, not real user financial records.

## Failure recovery
- Rebuild indexers from ledger cursor; compare DB projection vs chain truth.
- Restore DB backups after verifying transaction-intent reconciliation.
- Never republish user transactions solely because a client request timed out.
- Test signing-key rotation, dependency outages, stale quotes, malicious user input, insufficient balances and duplicate delivery.
- External reference infrastructure may change; check upstream project versions and licenses at build time.

---
# Scoped Potential Contributor Issues (not yet created on GitHub)

These are **potential tasks**, not manufactured or claimed completed contributions. Create issues only when actual dependencies and acceptance tests are ready.

- [ ] Define published cross-repo schema and OpenAPI/ABI golden fixture
- [ ] Create repository-specific CI checks and minimal sample test
- [ ] Build idempotent transaction intent state machine and reconciliation harness
- [ ] Add testnet happy-path E2E and timeout recovery
- [ ] Write contributor reproduction guide and dependency boundary tests
- [ ] Asset issuer trustline/flags verifier
- [ ] Native path quote adapter with slippage cap
- [ ] Orderbook liquidity/no-route fixture suite
- [ ] Merchant redemption policy validation
