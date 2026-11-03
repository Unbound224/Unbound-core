# Scoped contributor issues (candidates, not yet opened on GitHub)

These are **potential tasks**, not manufactured or claimed contributions. Each lists the repository, what "done"
means, and the acceptance test a reviewer will run. Open an issue only when its dependencies are ready. Done items
from earlier rounds (CI, schemas, intent state machine, reconciliation harness, issuer/trustline checks, path quotes,
no-route fixtures, policy validation, CORS, scheduled jobs, password reset, admin console, dispute UI, wallet backup,
the Soroban redemption escrow) were removed from this list.

## Unbound-stellar
- [ ] **Testnet smoke run with real hashes.** Write `scripts/testnet-smoke.ts` (Friendbot accounts, issuer setup,
  trustline, issue, quote, settle through `HorizonClient`) and, on a networked machine, run it and
  `scripts/deploy-testnet.sh`. *Acceptance:* a checked-in `contracts/deployments/testnet.json` and a markdown log with
  Testnet transaction hashes anyone can open on a Stellar explorer; README status updated from "never run".
- [ ] **Index escrow events from Soroban RPC `getEvents`.** Feed `decodeEscrowEvent` from a cursor-based event source.
  *Acceptance:* unit tests with recorded `getEvents` pages (golden fixtures), replay from a cursor is idempotent, and
  non-escrow events are skipped.
- [ ] **Liquidity-pool paths and reserve/liability checks in quotes.** *Acceptance:* failing-first tests showing a quote
  that the current code over-estimates because of selling liabilities, then the fix.
- [ ] **Publish the SDK to npm (provenance) and a gateway Docker image.** *Acceptance:* a tagged workflow run that
  publishes with provenance; `npm pack` content test.

## Unbound-core
- [ ] **PostgreSQL storage adapter behind the `Storage` port.** *Acceptance:* the existing storage and durability test
  suites run against Postgres in CI (service container) and pass unchanged.
- [ ] **Distributed job lock.** Jobs are idempotent but run once per instance. *Acceptance:* two app instances sharing
  storage run each job at most once per interval (test with two runners and a fake clock).
- [ ] **Real email provider for password reset (behind `Mailer`).** *Acceptance:* adapter test against a local SMTP
  sink; no token in logs; the dev `OutboxMailer` stays the default.
- [ ] **MFA (TOTP) for merchant and reviewer accounts.** *Acceptance:* login requires a valid TOTP once enrolled;
  replay and clock-skew tests; recovery codes are hashed.

## Unbound-site
- [ ] **Sign escrow actions with a browser wallet (Freighter).** *Acceptance:* the sign panel can hand the unsigned XDR
  to Freighter and submit the result; tests with a mocked `window.freighterApi`; the paste flow stays available.
- [ ] **Browser E2E in CI.** *Acceptance:* Playwright job that boots core (fake gateway) and the site, signs in and
  confirms a seeded redemption; runs on every PR.
- [ ] **Policy-signing helper.** *Acceptance:* builds the canonical policy bytes in the browser, shows them, and verifies
  a pasted signature against the issuer key before submitting.

## Unbound-mobile
- [ ] **Device test run of the release APK.** *Acceptance:* a `v*` tag produces `unbound-android.apk`; a recorded run on
  a physical Android device covers wallet create, backup, restore and an escrowed redemption against a dev core.
- [ ] **Block screenshots on the backup screen (Android FLAG_SECURE / iOS).** *Acceptance:* platform-channel code with a
  widget test proving the flag is requested while the recovery key is visible and cleared afterwards.
- [ ] **TalkBack / VoiceOver audit.** *Acceptance:* written audit with fixes for every blocking issue.
- [ ] **Localisation scaffold (ARB) with one extra locale.** *Acceptance:* every user-visible string comes from ARB files;
  a test fails on hard-coded strings in `lib/features`.
