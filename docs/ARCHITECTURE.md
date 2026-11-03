# Unbound — Cross-repository Architecture

## Why exactly four repositories?
These are four distinct deployable/reusable engineering domains. They must remain independently testable and publishable. Splitting arbitrary features into extra repos solely for Wave incentives is prohibited.

| Repository | Independent ownership | Outputs | Consumers |
|---|---|---|---|
| `unbound-mobile` | Consumer asset inventory, issuer discovery, offers, approvals, wallet/secure signing, redemption status, transaction receipts | Flutter mobile | product users or other repo services |
| `unbound-core` | Merchant onboarding, verified issuer/redemption policies, listings and reservations, user accounts, authorization, canonical operational data, dispute workflow | NestJS backend | product users or other repo services |
| `unbound-stellar` | Native Stellar asset issuance integration, account trustlines, issuer flags, order-book/path quoting, transactions, indexing/reconciliation, typed integration SDK | TypeScript Stellar-native SDK + chain worker | other project repos via versioned API/SDK |
| `unbound-site` | Public consumer landing, official store badges, merchant issuer console, merchant redemption operations, docs and partner onboarding | Next.js marketing + merchant portal | product users or other repo services |

## Request and ownership paths
```
Consumer Flutter -----> unbound-core <------ unbound-site merchant portal
                           |
                           v
                    unbound-stellar ------> Stellar assets, DEX, path payments
                           |
                           +-- indexed settlement state -> unbound-core
```
The mobile app does not own merchant verification, and the core API does not reimplement Stellar transaction algorithms. Site owns public marketing and merchant onboarding UI. The Stellar repo owns a reusable protocol SDK and watchers.

## Stellar integration: essential system, not decoration
- Native asset issuance: merchant issuance identity and redemption promise live off-chain, asset code+issuer on Stellar.
- Trustlines: consumer explicitly authorizes holding merchant-issued assets; issuer authorization flags respected.
- Native offers/order books and strict-send/strict-receive path payments produce actual conversion/settlement.
- Horizon/RPC reads and transaction history become verifiable ledger records; service indexer reconciles finality.
- Soroban is used in exactly one place: the redemption-return escrow (`unbound-stellar/contracts/redemption-escrow`,
  ADR 0002 in unbound-stellar). Returned credit is held by the contract until the issuer confirms (released to the
  issuer), rejects (refunded) or the deadline passes (anyone can trigger the refund). Classic assets cannot express that
  conditional custody without a custodian. Everything else stays classic Stellar; core falls back to the native return
  payment whenever the escrow is unavailable.

## Service and package contracts
- OpenAPI for network APIs; generated Dart/TypeScript clients; schema snapshots checked into CI.
- Published package semver for reusable SDK/contract bindings; explicit peer version compatibility table.
- Idempotency tokens across all state-changing network/ledger operations.
- Reconciliation event contract: `{id, sourceRepo, schemaVersion, network, ledgerCursor, entityRef, status, observedAt}`.
- Never assume a wallet knows off-chain business rights or that an API database can overrule confirmed on-chain state.

## Integration test order
1. Each repository passes independent lint/build/unit tests.
2. Publish local SDKs and generated interfaces.
3. Run network local/sandbox or Testnet tests.
4. Run API/service orchestration tests with fake wallets and then test wallets.
5. Run frontend/device E2E.
6. Verify failure and recovery (network loss, duplicate event, stale authorization, partial settlement).

## Long-term release strategy
- Independent tags/releases in each repo.
- Project-wide integration lockfile references tested SHAs/tags of dependencies.
- Before shipping any release, each repo README links the matching version of its three siblings.
