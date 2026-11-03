# Contributing to Unbound-core

Thanks for helping build Unbound. This repository is one of four with clear ownership boundaries
(see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)); please keep changes inside this repo's boundary and coordinate
contract changes with the sibling repos.

## Ground rules

- **Financial truth first.** Never show money as settled before the ledger confirms it; never claim liquidity,
  fiat cash-out, partners, store listings or Mainnet availability that do not exist.
- **Testnet and synthetic data only.** No real funds, real customer data or secret keys - in code, tests, fixtures,
  screenshots or issues.
- **No fabricated work.** Screenshots must come from the real software; test adapters must be clearly labelled.
- Read [`AGENTS.md`](./AGENTS.md) and the milestone gates in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Getting started

```
npm ci
npm run check        # lint + typecheck + tests + build
```

`npm run check` must pass before you open a pull request; CI runs the same steps.

## Pull requests

1. Pick or propose an issue. Scoped ideas with acceptance criteria are in
   [`docs/CONTRIBUTOR_ISSUES.md`](./docs/CONTRIBUTOR_ISSUES.md).
2. Branch from `main`, keep the change small and focused, and use
   [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `test:`, `ci:` ...).
3. Add tests for new behavior **and its failure paths**.
4. If you change a public contract (OpenAPI, JSON schema, fixtures, SDK exports), update the versioned fixtures and
   describe the impact on sibling repos in the PR.
5. Fill in the pull request template.

## Drips Wave

Unbound intends to take part in [Drips Wave](https://docs.drips.network/wave/maintainers/participating-in-a-wave/).
Participation is subject to Drips' review and per-organization limits; nothing about rewards is promised here. Wave
issues will be created from `docs/CONTRIBUTOR_ISSUES.md` only when their dependencies and acceptance tests are ready.

## Conduct and security

Everyone participating agrees to the [Code of Conduct](./CODE_OF_CONDUCT.md). Report vulnerabilities privately as
described in [`SECURITY.md`](./SECURITY.md).
