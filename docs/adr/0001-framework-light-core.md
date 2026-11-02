# ADR 0001: Framework-light TypeScript core for M1/M2; NestJS/Prisma/Postgres deferred

Status: accepted

## Context
`docs/TECHNICAL_BUILD.md` recommends NestJS + PostgreSQL + Prisma + Redis/BullMQ. The first deliverable
had to prove domain logic and failure paths with real tests, without databases available in the build
sandbox and without pretending persistence exists.

## Decision
- Domain/application services are plain TypeScript classes with ports (`Repository<T>`,
  `StellarGateway`, `Clock`). They hold all business rules and are framework independent, so wrapping them
  in NestJS controllers/providers later is mechanical.
- HTTP is a small `node:http` router (`src/http/server.ts`) implementing the v1 contract and error schema.
- Persistence is `InMemoryRepository` (labeled; lost on restart). A Prisma/PostgreSQL repository
  implementation behind the same port is open work (see CONTRIBUTOR_ISSUES.md).
- The Stellar side is the `StellarGateway` port. Only `FakeStellarGateway` (test adapter) exists; a real
  adapter will call `unbound-stellar` once it is published. Core never builds Stellar transactions.
- Intent lifecycle uses the SRD names (DRAFT, VERIFIED, AWAITING_SIGNATURE, SUBMITTED, RECONCILING,
  CONFIRMED, FAILED) plus CANCELLED. `docs/STELLAR_PROTOCOL.md` names (CREATED, QUOTED, USER_APPROVED) map
  to: quote stored -> DRAFT, server checks -> VERIFIED, user approval == signing -> AWAITING_SIGNATURE.

## Consequences
Restarts lose data; no job queue exists (stuck-intent recovery is a callable method, not a scheduled job).
