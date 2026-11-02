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
