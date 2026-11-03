<div align="center">

<img src="https://raw.githubusercontent.com/Unbound224/Unbound-core/main/brand/icon.svg" alt="Unbound" width="96" height="96" />

# Unbound

**Turn stranded value into something usable.**

Exchange store credit that a retailer has genuinely issued and agreed to honor for other Stellar assets -
at a real quote, signed on your own device. Open source, built on Stellar, Testnet only today.

</div>

### What we are building

- **Issuer-authorized credit only.** Verified merchants sign a redemption policy with their Stellar issuer key and
  authorize every holder. No issuer, no usable credit.
- **Real quotes or none.** Strict-send path payments through Stellar's order books, with an expiry and a minimum you
  receive. Unbound never promises liquidity, a price or fiat cash-out.
- **Ledger-truthful.** Nothing is shown as settled until the ledger confirms it; unknown outcomes are reconciled by hash.

### Repositories

| Repository | What it owns | Stack |
|---|---|---|
| [**Unbound-core**](https://github.com/Unbound224/Unbound-core) | Issuer verification, signed redemption policies, exchange-intent state machine, redemptions, disputes, audit | TypeScript, Node 22 |
| [**Unbound-stellar**](https://github.com/Unbound224/Unbound-stellar) | Trustline and issuer checks, path quotes, unsigned transaction builders, submission, reconciliation | TypeScript, Stellar SDK |
| [**Unbound-mobile**](https://github.com/Unbound224/Unbound-mobile) | Consumer wallet: inventory, quote review, on-device XDR inspection and signing | Flutter |
| [**Unbound-site**](https://github.com/Unbound224/Unbound-site) | Landing page, partner docs, merchant redemption console | Next.js |

### Status

Pre-release. Every repository has CI and an honest status table. Core logic is implemented and tested offline and
against a local ledger simulator; **nothing has run on live Stellar Testnet yet**, the app is not in any app store,
and there is no Mainnet deployment, external audit or partner programme.

### Contribute

Read a repository's `CONTRIBUTING.md`, then pick from its `docs/CONTRIBUTOR_ISSUES.md`. We intend to take part in
[Drips Wave](https://docs.drips.network/wave/maintainers/participating-in-a-wave/) (subject to Drips' review).
Security reports: privately via each repository's **Security** tab.

<sub>To use this as the organization profile, copy it to `profile/README.md` in a public `Unbound224/.github`
repository, and upload `brand/org-avatar.png` under Organization settings -> Profile.</sub>
