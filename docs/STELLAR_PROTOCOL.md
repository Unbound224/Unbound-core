# Unbound — Stellar Protocol and Financial Data Contracts

## Why native Stellar (not a generic Soroban escrow)
The credit itself is a classic Stellar issued asset `(asset_code, issuer_account)`; users establish trustlines and exchange assets using classic Stellar orderbook/path-payment primitives. The ledger is the settlement and transferable-credit substrate; there is no custom Unbound token required for MVP.

### Mandatory issuer contract (off-chain real-world agreement)
For each asset the backend must store an independent, human-readable, signed redemption policy: issuer legal identity + verification, asset code + issuer public key, unit-of-account meaning, face-value/redemption limitations, expiry, jurisdiction, refund/cancellation policy, contact information and KYC requirements. Issuer's permission to tokenize and transfer credits must be affirmative. A Stellar asset is **not** evidence that a shop will redeem it; legal identity & operational history require separate review.

### Native workflow
1. Verified merchant publishes an AssetProgram in `unbound-core`; Stellar adapter checks asset flags/account configuration and issuer trust.
2. Issuer creates a real Testnet credit asset and distributes a sample position to a user with the proper trustline; asset precision fixed at 7 decimal places on classic Stellar (use integer stroops-like base units).
3. Consumer requests sell asset and target asset; `unbound-stellar` queries actual path/offer liquidity; returns a **time-bounded indicative quote** including source/destination issuer addresses, network fees, `minDestinationAmount` or `maxSourceAmount`, liquidity depth, explicit slippage cap, and warning if no path exists.
4. `unbound-core` returns an unsigned transaction XDR (or safe wallet signing description) without ever requesting the user's secret key. User reviews exactly what they sign.
5. Broadcast and reconcile by transaction hash. A timed-out HTTP request after broadcast remains `RECONCILING`, not failed.
6. On success, buyer receives target supported asset and the ledger-derived receipt shows exact amounts. Merchant redemption uses a separate verified flow and may require returned/burned credit.

### Quote/intent request
```json
{
  "schemaVersion": "1.0",
  "sourceAsset": {"code":"SHOP","issuer":"G_TESTNET_ISSUER_PUBLIC_KEY"},
  "targetAsset": {"code":"USDC","issuer":"G_TESTNET_TARGET_ISSUER"},
  "sourceAmount": "80.0000000",
  "minimumDestinationAmount": "72.0000000",
  "slippageBps": 100,
  "destinationAccount": "G_TESTNET_USER_PUBLIC_KEY",
  "network": "TESTNET"
}
```
Values are **illustrative**, not actual quotes or usable addresses. Contract validation must reject untrusted issuers, unsupported assets, expired quotes, invalid amounts, missing trustlines and unapproved routes.

### Redemption-return escrow (Soroban, the one contract)
Redemption returns can go through `unbound-redemption-escrow` (soroban-sdk 29.0.1). The credit is still the classic
issued asset; the contract moves it through the asset's Stellar Asset Contract.
- `open_return(consumer, issuer, token, amount, redemption_id, deadline)`: consumer-authorized; `redemption_id` is
  sha256 of core's redemption id and single-use forever; deadline 1 hour to 30 days ahead; `issuer` must be the SAC admin.
- `confirm(id)` (issuer, before the deadline) -> credit to the issuer (burned); `reject(id)` (issuer, any time while
  open) -> refund; `expire_refund(id)` (anyone, at/after the deadline) -> refund.
- Invariant: escrow balance per token == `locked(token)` == sum of open returns.
- Issuers with `AUTH_REQUIRED` must authorize the escrow contract on their SAC once (`set_authorized`).
- Core uses it through `StellarGateway.escrow`; any `ESCROW_*` refusal falls back to the native return payment.
- Not deployed yet: no Testnet contract id exists; `scripts/deploy-testnet.sh` in unbound-stellar is written, not run.

### Settlement observability
- Transaction lifecycle: `CREATED → QUOTED → USER_APPROVED → SUBMITTED → CONFIRMED` or `RECONCILING/FAILED/CANCELLED`.
- Key fields: `networkPassphrase`, `assetCode`, `issuer`, `amountIn`, `minOut`, `amountOutActual`, `sequence`, `memo`, `txHash`, `ledger`, `observedAt`, `reconciliationVersion`.
- Deduplicate by network + hash and classify failed path payments separately from submitted-but-unobserved.
- Secrets never flow from mobile to backend. Fee sponsorship must be explicit, not promised by default.

### Tests
- untrusted issuer rejected;
- trustline missing or unauthorized → blocked;
- insufficient native DEX liquidity → no quote;
- minimum output violation → transaction fails safely;
- quote expiration before signature → request new approval;
- duplicate submit idempotent;
- redemption of unsupported credit → unavailable, never fake cash-out.
