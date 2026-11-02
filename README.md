<img src="./brand/icon.svg" alt="Unbound logo" width="144" />

# unbound-core

> Unbound — Turn stranded value into something usable.

**Status: domain core + HTTP v1 slice implemented and tested in-process; storage is in-memory and the Stellar side is a labeled fake. See "Status" below.** This repo is one of **exactly four meaningful independent codebases** in the Unbound Stellar-native project. It is not a placeholder created merely to increase Drips Wave submissions.

## Owns
Merchant onboarding, verified issuer/redemption policies, listings and reservations, user accounts, authorization, canonical operational data, dispute workflow

## Why it is separate
It has a distinct runtime/toolchain, external interface, tests, release cadence and maintainership boundary. Its siblings depend on its delivered interface, but implementation responsibilities must not be duplicated.

## Sibling repositories
- `unbound-mobile` — Consumer asset inventory, issuer discovery, offers, approvals, wallet/secure signing, redemption status, transaction receipts
- `unbound-stellar` — Native Stellar asset issuance integration, account trustlines, issuer flags, order-book/path quoting, transactions, indexing/reconciliation, typed integration SDK
- `unbound-site` — Public consumer landing, official store badges, merchant issuer console, merchant redemption operations, docs and partner onboarding

## Architecture and development context
Start with:
- `AGENTS.md` — coding agent rules;
- `docs/PRD.md` — product purpose and MVP;
- `docs/SRD.md` — user/system requirements, APIs and state;
- `docs/ARCHITECTURE.md` — four-repository responsibilities, data and execution paths;
- `docs/TECHNICAL_BUILD.md` — recommended bootstrap, testing, phases;
- `docs/SECURITY.md` — security/trust boundaries;
- `docs/BRAND.md` — approved flat logo and flexible UI direction;
- `docs/ROADMAP.md` — milestone acceptance gates.

## Status (honest)
| Capability | State |
|---|---|
| Merchant apply / admin verify (evidence ref required) / revoke; revocation suspends programs at once | Implemented, tested |
| Signed redemption policy (ed25519 by the issuer key, strict schema, expiry, key/code binding, explicit tokenization + transfer permission) | Implemented, tested |
| Asset eligibility evaluated fresh on every use; trusted-asset list for `unbound-stellar` | Implemented, tested |
| **Durable storage**: `Storage` port with SQLite (`node:sqlite`, experimental in Node 22) and migrations; sessions, challenges, targets, audit sequence and the reconciliation pause survive restarts | Implemented, tested (restart tests) |
| **Auth**: wallet challenge/verify for consumers; scrypt email+password for merchants/admins with lockout, logout, disable; merchant context resolved per request | Implemented, tested |
| Exchange quote -> intent -> submit state machine (idempotency keys, write-ahead SUBMITTED, RECONCILING on unknown outcome, stale quote / revoked issuer blocks, recovery method) | Implemented, tested incl. concurrent duplicates |
| Reconciliation consumer (contract v1.0, strict, fail-closed, dedupe by event id, discrepancy pauses sensitive actions) | Implemented, tested |
| Redemption (verified credit only, signed limits, merchant confirms after ledger-confirmed return, rejection flags `refundDue`) | Implemented, tested |
| **`GET /v1/portfolio`**: ledger balances classified REDEEMABLE / SUPPORTED_ASSET / UNVERIFIED / SUSPENDED / EXPIRED / FROZEN | Implemented, tested (fake gateway) |
| **Disputes**: open on own redemption/exchange, scoped visibility, merchant response window + escalation, admin ruling (records only, never moves funds) | Implemented, tested |
| **`HttpStellarGateway`**: real adapter for the unbound-stellar gateway service (strict response validation, timeouts, unknown outcome throws) | Implemented; contract-tested with shared fixtures |
| **Cross-repo tests**: fixture parity with `../Unbound-stellar` and a real core<->gateway-service exchange/failure/reconcile/redemption run | Implemented; run when the sibling checkout exists (SimulatedLedger behind the gateway, not Testnet) |
| Dev seed (synthetic) and Dockerfile/docker-compose | Seed tested. Compose is only syntax-checked (`docker compose config`); containers never built or run |
| Audit trail; OpenAPI 3.1 (snapshot-tested) | Implemented |
| **PostgreSQL/Prisma** | **Not done.** SQLite behind the `Repository` port is the interim durable store (documents + JSON filter in memory; not for scale) |
| **Live Testnet / real Horizon** | **Never run.** The gateway service (in unbound-stellar) uses Horizon adapters that are type-checked and mapping-tested only |
| NestJS, Redis/BullMQ queues, rate limiting (except login lockout), email verification/password reset, MFA | Not done |
| Scheduled jobs (`recoverStuck`, `escalateOverdue` are callable, not scheduled) | Not done |

## Contracts
- `openapi/openapi.json` - v1 HTTP contract (additive endpoints are labeled in the document).
- `fixtures/reconciliation-event.confirmed.v1.json` and `fixtures/reconciliation-event.stellar-schema.v1.json` are copies of the
  producer's (`unbound-stellar`) golden fixture and schema; a test fails if our consumer schema drifts from the snapshot.
- Idempotency: `Idempotency-Key` header on `POST /v1/exchange/intents`, `.../submit`, `POST /v1/redemptions`.

## Security notes
No secrets in the repo; keys in tests are generated per run. The service accepts only `TESTNET`. It never receives
a user secret, never stores signed transactions in audit data, and never parses/builds Stellar transactions.

## Sibling versions
Developed against `unbound-stellar` / `unbound-site` / `unbound-mobile` at their `claude/drips-wave-maintainer-projects-iwucl5` branches (untagged).

## Minimal integration contract
Always test the dependency path stated in ARCHITECTURE.md. Every new public endpoint/ABI/package message must be versioned and covered by consumer fixtures. See `docs/SRD.md` and `docs/TECHNICAL_BUILD.md`.

## Drips Wave
Stellar is essential: Native asset issuance: merchant issuance identity and redemption promise live off-chain, asset code+issuer on Stellar. Approval/eligibility for Wave depends on substantive open-source implementation and organizer review, not repo count.


## Official project identity

The project uses the **approved flat SVG logo** in [`brand/icon.svg`](./brand/icon.svg), with an editable transparent vector mark in [`brand/mark.svg`](./brand/mark.svg). The [512 px GitHub organization avatar](./brand/org-avatar.png) is in the same directory. This logo is shared by all four project repositories. UI design remains intentionally flexible.
