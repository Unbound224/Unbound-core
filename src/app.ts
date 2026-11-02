import { AuditLog } from './common/audit.js';
import { systemClock, type Clock } from './common/ids.js';
import { ExchangeService } from './modules/exchange/service.js';
import type { StellarGateway } from './modules/exchange/gateway.js';
import { IssuerService } from './modules/issuers/service.js';
import { OperationsGuard } from './modules/reconciliation/guard.js';
import { ReconciliationService } from './modules/reconciliation/service.js';
import { RedemptionService } from './modules/redemption/service.js';
import { InMemoryStorage, type Storage } from './persistence/storage.js';
import { PortfolioService } from './modules/portfolio/service.js';
import { AuthService } from './modules/auth/service.js';
import type { Actor } from './common/auth.js';
import { WalletService } from './modules/wallets/service.js';

/** Composition root. All persistence is in-memory (see README status). */
export function createApp(opts: { gateway: StellarGateway; clock?: Clock; storage?: Storage }) {
  const clock = opts.clock ?? systemClock;
  const storage = opts.storage ?? new InMemoryStorage();
  const audit = new AuditLog(clock, storage.repo('audit_events'));
  const guard = new OperationsGuard(audit, storage);
  const wallets = new WalletService(clock, audit, storage);
  const issuers = new IssuerService(clock, audit, storage);
  const auth = new AuthService(clock, audit, wallets, storage);
  const common = { clock, audit, issuers, wallets, gateway: opts.gateway, guard, storage };
  const portfolio = new PortfolioService(common);
  const exchange = new ExchangeService(common);
  const redemption = new RedemptionService(common);
  const reconciliation = new ReconciliationService({ clock, audit, guard, storage });
  reconciliation.register((o, r) => exchange.onObservation(o, r));
  reconciliation.register((o, r) => redemption.onObservation(o, r));
  /** Resolves a bearer token to an actor; merchant accounts get their CURRENT merchantId (never stale). */
  async function authenticate(token: string | undefined): Promise<Actor | undefined> {
    const actor = await wallets.authenticate(token);
    if (actor?.role !== 'merchant') return actor;
    const mine = (await issuers.merchants.find((m) => m.ownerActorId === actor.id && m.status !== 'REJECTED'))[0];
    return mine ? { ...actor, merchantId: mine.id } : actor;
  }
  return { portfolio, authenticate, auth, storage, clock, audit, guard, wallets, issuers, exchange, redemption, reconciliation };
}

export type App = ReturnType<typeof createApp>;
