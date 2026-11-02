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

