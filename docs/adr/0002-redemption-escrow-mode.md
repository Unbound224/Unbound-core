# ADR 0002: Escrowed redemptions through the StellarGateway port, native return as fallback

Status: accepted. Companion to
[unbound-stellar ADR 0002](https://github.com/Unbound224/Unbound-stellar/blob/main/docs/adr/0002-soroban-redemption-escrow.md),
which explains why the redemption-return escrow is the one place Unbound uses Soroban.

## Context
A native redemption return is a classic payment to the issuer: the credit is burned on arrival, so a
merchant rejection can only set `refundDue = true` and leave the refund to an off-chain process or a
dispute. unbound-stellar now ships a Soroban escrow that holds the returned credit until the issuer
confirms, rejects (on-chain refund) or the deadline passes (anyone can trigger the refund).

## Decision
- Core still never builds or parses Stellar transactions. The `StellarGateway` port gains an optional
  `escrow: RedemptionEscrowGateway` (open, confirm, reject, expire, getReturn). `HttpStellarGateway`
  exposes it only when `STELLAR_ESCROW_ENABLED=true`; `FakeStellarGateway.enableEscrow()` provides a
  labeled test adapter that emulates the contract rules.
- `POST /v1/redemptions` tries the escrow first. Any `ESCROW_*` gateway error (not configured, the issuer
  has not authorized the escrow for its `AUTH_REQUIRED` credit, paused, simulation refused) records
  `REDEMPTION_ESCROW_FALLBACK` in the audit log and builds the native return instead. Each redemption
  stores `mode: NATIVE | ESCROW`; records from before this change read as NATIVE.
- Escrow mode keeps the existing states and adds one terminal state, `EXPIRED`
  (`RETURN_CONFIRMED -> EXPIRED`). `escrow.state` tracks the contract side:
  `AWAITING_OPEN -> HELD -> RELEASED | REFUNDED | EXPIRED_REFUNDED`.
- Merchant confirm/reject and the holder's timeout refund each build one unsigned transaction
  (`escrow.pending`) for the right signer (issuer for confirm/reject, holder for the refund). The state
  changes only when the ledger confirms that transaction, by the submit verdict or a reconciliation event
  for its hash. A failed transaction clears `pending` and records `lastFailure`; an unknown outcome keeps
  `pending` until the ledger decides.
- A scheduled job (`reconcileEscrows`) reads the contract for every held return, applies closes made
  outside core (for example a third party calling `expire_refund`), and records a `DISCREPANCY` when the
  contract has no record of a return core believes is held.

## Consequences
- In escrow mode a rejection is refunded on-chain (`refundDue = false`). Native mode is unchanged.
- Merchants sign confirm/reject with their issuer key outside Unbound (the console shows the XDR and
  accepts the signed envelope); Unbound never holds issuer keys.
- Not done: running against a deployed Testnet contract (none exists), fee sponsorship for the refund.
