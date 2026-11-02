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
| Asset eligibility evaluated fresh on every use; trusted-asset list for `unbound-stellar`'s registry | Implemented, tested |
| Wallet challenge/verify (one-time, expiring, signature only; no secrets) and bearer sessions | Implemented, tested |
| Exchange quote -> intent -> submit state machine with idempotency keys, write-ahead SUBMITTED, RECONCILING on unknown outcome, stale quote / revoked issuer blocks, crash recovery method | Implemented, tested (incl. concurrent duplicate requests) |
| Reconciliation event consumer (contract v1.0, strict, fail-closed on unknown network/version, dedupe by event id, discrepancy pauses sensitive actions) | Implemented, tested; schema compared to unbound-stellar's published snapshot |
| Redemption: only credit with an active verified program, within signed limits; merchant confirms only after the return is ledger-confirmed; rejection after return flags `refundDue` | Implemented, tested |
| Audit trail (actor, scope, action, time, object, requestId; refuses secret-like keys) | Implemented, tested |
| OpenAPI 3.1 for the v1 endpoints (`openapi/openapi.json`, snapshot-tested) | Implemented |
| **Persistence (PostgreSQL/Prisma)** | **Not done.** `InMemoryRepository` only; data is lost on restart |
| **Real Stellar integration** | **Not done.** Only `FakeStellarGateway` (test adapter, no real XDR/hashes). No cross-repo E2E has been run |
| `GET /v1/portfolio` | Not implemented (needs gateway balance reads) |
| NestJS, Redis/BullMQ queues, rate limiting, merchant/admin real authentication | Not done (dev sessions via `mintDevSession` are TEST/DEV only) |
| Disputes workflow | Not done |

## Quick start
```
npm ci
npm run check      # lint + typecheck + tests + build
npm run openapi    # regenerate openapi/openapi.json
npm start          # DEV ONLY: 127.0.0.1:3001 with the fake gateway + in-memory storage
```

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
