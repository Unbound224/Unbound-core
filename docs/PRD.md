# Unbound — Product Requirements Document

**Status:** technical product specification, preimplementation. **Platform:** Flutter mobile (iOS/Android) plus merchant/landing web.  **Target:** Stellar Testnet demo, real adoption only after risk/legal validation.

## Vision
An issuer-authorized marketplace for genuinely redeemable, transferable merchant credits. A user can receive digital store credit issued on Stellar and exchange it through native Stellar liquidity for another supported asset. The product does not magically convert an arbitrary gift card, nor promise liquidity or fiat withdrawal.

## Who needs it
Retailers or partners must opt in as issuers. Only verified, transferable and redeemable asset programs are supported.

## Core user outcomes
- issuer registry and legal redemption terms
- merchant-issued Stellar asset and trustline setup
- discover transferable credits, balances, value and redemption rules
- user-approved swap, slippage cap, quote expiry, settlement
- merchant redemption and burn/return procedure
- audit trail and safe transaction-state recovery

## Core customer journey
1. Issuer is verified and publishes authentic redemption terms for a transferable asset.
2. Merchant issues a supported sample credit on Stellar Testnet.
3. Holder sees actual credit, issuer identity, redemption obligations, trustline requirements.
4. Holder obtains a quote based on actual available path/order-book liquidity.
5. The user approves exact sell amount, minimum receive amount, fees, issuer risks, and signed transaction.
6. Stellar settlement is observed; balances and receipt reconcile.
7. Holder can also redeem supported credit with the participating merchant, following real issuer rules.

## Functional requirements
- issuer registry and legal redemption terms
- merchant-issued Stellar asset and trustline setup
- discover transferable credits, balances, value and redemption rules
- user-approved swap, slippage cap, quote expiry, settlement
- merchant redemption and burn/return procedure
- audit trail and safe transaction-state recovery

## Non-goals for first MVP
- convert every proprietary loyalty point or gift card
- instant bank withdrawals worldwide
- unlicensed custody or guaranteed secondary-market liquidity
- speculative credit token trading unrelated to real redemption

## Safety and commercial reality
- No issuer means no usable store credit. Never claim arbitrary voucher imports are cashable.
- Trustlines, asset flags, issuer authorization and revocation/clawback policies affect the user experience.
- Liquidity and slippage can prevent an exchange; quotes must expire and cannot be guaranteed.
- Bank-cashout requires licensed partners, and cross-border/consumer-credit rules differ by jurisdiction.

## Core success measures
- successful asset redemption percentage
- quote-to-settlement success
- settlement/reconciliation lag
- user fee+slippage disclosed vs charged
- verified issuer availability

## Acceptance tests
- Merchant can issue a sample redeemable credit on Testnet with documented terms.
- Buyer can establish required trustline and receive credit.
- A quoted trade shows all assets, issuer addresses, fees, slippage and expiry.
- A valid trade settles on Stellar Testnet and creates a reconciled receipt.
- No-liquidity/no-trustline/unauthorized asset routes fail safely without spending.
- Merchant can complete a simulated redemption and reconcile the asset movement.

## Repository architecture
See `ARCHITECTURE.md`. Exactly four repos are proposed as stable engineering ownership boundaries. Reducing or increasing them requires a written technical justification, not reward optimization.
