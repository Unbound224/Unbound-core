# Contributing to Unbound-core

Thanks for helping build Unbound. This repository is the system of record: issuer verification, signed redemption policies, exchange intents, redemptions, disputes and the audit trail. It never builds or parses Stellar transactions. It is one of four repositories with clear boundaries (see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)). Keep changes inside this boundary and describe the effect on the sibling repos when you touch a shared contract.

## Ground rules

- **Financial truth first.** Never show money as settled before the ledger confirms it. Never claim liquidity, fiat cash-out,
  partners, store listings or Mainnet availability that do not exist.
- **Testnet and synthetic data only.** No real funds, real customer data or secret keys in code, tests, fixtures, screenshots or issues.
- **Show real work.** Screenshots come from the real software. Test adapters are clearly labelled as test adapters.
- **Test the failure paths**, not only the happy path.

## Set up

```bash
npm ci
npm run check        # lint + typecheck + tests + build, the same steps CI runs
```

Run a local server with durable SQLite and a synthetic seed (see the README quick start). Tests that need a sibling checkout (`Unbound-stellar`, `Unbound-site`) skip when it is missing, so check the skipped count.

## Picking work (Drips Wave)

We take part in the [Stellar Wave Program](https://www.drips.network/wave/stellar). Work is tracked in
[issues labelled `Stellar Wave`](https://github.com/Unbound224/Unbound-core/issues?q=is%3Aopen+label%3A%22Stellar+Wave%22).

| Label | Meaning | Wave points |
|---|---|---|
| `trivial` | Small, clearly bounded change with obvious acceptance criteria | 100 |
| `medium` | Standard feature or logic touching several parts of the codebase | 150 |
| `high` | Complex engineering such as an integration or an architectural change | 200 |

Points are Drips' scale. We tag honestly and never promise a reward; payouts follow Drips' own rules and review.

How to claim an issue:

1. Read the whole issue: summary, context, scope, implementation notes and acceptance criteria.
2. Comment that you want it, with a sentence on your approach. A maintainer will assign it to you.
3. Open a draft PR early if the scope is unclear. Ask questions in the issue, not in private.
4. One issue per PR. Do not bundle unrelated changes.

Issues that are inactive for seven days after assignment go back to the pool.

## Pull requests

1. Branch from `main` and keep the change small and focused.
2. Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `test:`, `ci:`).
3. Add tests for new behavior and its failure paths.
4. If you change a public contract (OpenAPI, JSON schema, fixtures), regenerate the snapshot (`npm run openapi`), update the versioned fixtures and describe the impact on `Unbound-stellar`, `Unbound-site` and `Unbound-mobile` in the PR.
5. Fill in the pull request template, link the issue (`Closes #123`) and show the evidence: the check output, and for ledger changes a Testnet
   transaction hash when relevant.

What reviewers look for: the acceptance criteria in the issue are met one by one, `npm run check` is green, failure paths are tested, no secrets or
real data appear anywhere, and the diff does not touch unrelated files.

## Conduct and security

Everyone participating agrees to the [Code of Conduct](./CODE_OF_CONDUCT.md). Report vulnerabilities privately as described in
[`SECURITY.md`](./SECURITY.md). Questions go in [Discussions](https://github.com/Unbound224/Unbound-core/discussions).
