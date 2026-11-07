# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Testnet only; no production deployment exists.

## [0.1.0] - 2026-11-06 - Testnet prototype

### Added
- Admin TOTP MFA (`/v1/auth/mfa/enroll|activate|disable`, optional `code` on login, `MFA_REQUIRED` error, secrets sealed with
  `MFA_ENCRYPTION_KEY`); `POST /v1/admin/targets`; `ResendMailer` (`MAIL_PROVIDER=resend`); `SqliteJobLock` job leases;
  `sync-trusted-assets` job (core now feeds the gateway's trusted-asset registry); `scripts/testnet-e2e.ts` and
  `scripts/testnet-exchange.ts` (live Testnet runs).
- Escrowed redemptions through `StellarGateway.escrow` (ADR 0002): issuer-signed confirm / reject, holder timeout
  refund, new `EXPIRED` state, `escrow` projection (deadline, state, refundAvailable, pending XDR), native return as
  automatic fallback; `FakeEscrow` test adapter; cross-repo tests against the real stellar gateway.
- HTTP: `POST /v1/merchants/me/redemptions/:id/reject`, `.../escrow/submit`, `POST /v1/redemptions/:id/refund`,
  `.../escrow/submit`, `GET /v1/admin/merchants`, `POST /v1/admin/merchants/:id/revoke`, `GET /v1/admin/jobs`,
  `POST /v1/admin/jobs/:name/run`, `POST /v1/auth/password-reset`, `.../confirm`.
- Configurable CORS (`CORS_ALLOWED_ORIGINS`).
- `JobRunner` with non-overlapping runs and bounded backoff; jobs for stuck intents, overdue disputes and escrow
  reconciliation, started by the dev server unless `JOBS_ENABLED=false`.
- Password reset with single-use hashed tokens, throttling and session revocation; `Mailer` port with a dev-only
  `OutboxMailer`.

### Changed
- Merchant confirm answers 202 while an escrow release waits for the ledger.

## Earlier work (fake gateway only)
- Issuer verification, signed policies, exchange intents, reconciliation, redemptions, disputes, SQLite storage,
  OpenAPI 3.1 snapshot.
