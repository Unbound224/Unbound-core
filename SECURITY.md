# Security policy

Unbound is **pre-release software that runs on Stellar Testnet with synthetic assets only**. There is no production
deployment, no Mainnet deployment and no real funds. Even so, we treat security reports seriously: the code is meant to
become the basis of a system that moves value.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes (fixes land here) |
| anything else | No |

The only release is the `v0.1.0` Testnet prototype; there is no stable release.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: open the [**Security** tab of this repository](https://github.com/Unbound224/Unbound-core/security)
and choose **Report a vulnerability** (private vulnerability reporting). If that option is not available, open an issue
that says only that you have a security report and would like a private channel; a maintainer will reach out.

Please include what you found, how to reproduce it (Testnet / synthetic data only), the impact you expect and any
suggested fix.

## What to expect

- This is a small volunteer-maintained project; we aim to acknowledge reports within 7 days, but cannot promise an SLA.
- We will confirm the issue, agree on a disclosure timeline with you and credit you in the fix unless you prefer not.
- There is **no bug bounty** programme.

## Scope

In scope: code in this repository and its interaction with the other Unbound repositories
([core](https://github.com/Unbound224/Unbound-core), [stellar](https://github.com/Unbound224/Unbound-stellar),
[site](https://github.com/Unbound224/Unbound-site), [mobile](https://github.com/Unbound224/Unbound-mobile)).
Examples: authorization bypass, signing something other than what the user approved, secret-key exposure, replay or
double-spend paths, accepting a non-Testnet network or an unverified issuer, injection, leaking personal data.

Out of scope: attacks needing a compromised device or maintainer account, denial of service against third-party
infrastructure (Horizon, GitHub), and findings that only affect the clearly labelled test adapters.

Never use real funds, real customer data or Mainnet accounts while researching.

The project threat model is in [`docs/SECURITY.md`](./docs/SECURITY.md).
