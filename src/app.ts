import { AuditLog } from './common/audit.js';
import { systemClock, type Clock } from './common/ids.js';
import { ExchangeService } from './modules/exchange/service.js';
import type { StellarGateway } from './modules/exchange/gateway.js';
import { IssuerService } from './modules/issuers/service.js';
import { OperationsGuard } from './modules/reconciliation/guard.js';
import { ReconciliationService } from './modules/reconciliation/service.js';
import { RedemptionService } from './modules/redemption/service.js';
import { WalletService } from './modules/wallets/service.js';

/** Composition root. All persistence is in-memory (see README status). */
export function createApp(opts: { gateway: StellarGateway; clock?: Clock }) {
  const clock = opts.clock ?? systemClock;
  const audit = new AuditLog(clock);
  const guard = new OperationsGuard(audit);
  const wallets = new WalletService(clock, audit);
  const issuers = new IssuerService(clock, audit);
  const common = { clock, audit, issuers, wallets, gateway: opts.gateway, guard };
  const exchange = new ExchangeService(common);
  const redemption = new RedemptionService(common);
  const reconciliation = new ReconciliationService({ clock, audit, guard });
  reconciliation.register((o, r) => exchange.onObservation(o, r));
  reconciliation.register((o, r) => redemption.onObservation(o, r));
  return { clock, audit, guard, wallets, issuers, exchange, redemption, reconciliation };
}

export type App = ReturnType<typeof createApp>;
