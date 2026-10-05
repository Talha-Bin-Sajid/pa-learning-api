# ADR 0001 - The Node API is the only data client

**Status:** Accepted · 2026-10-04

## Context

Supabase offers direct browser access to Postgres via PostgREST + RLS. The project requires Clean Architecture
with business rules in the domain/application layers and authorization enforced by the backend.

## Decision

- The React app uses supabase-js **only for authentication** (sign-in, session, token refresh).
- All data access goes through the Node API, which connects to Postgres with `pg` (parameterized SQL) and to
  Storage/Auth-admin with the service-role key.
- Every public table has RLS enabled with **no policies**, and default grants to `anon`/`authenticated` are revoked.

## Consequences

- One place to enforce authorization and validation; domain rules are unit-testable.
- The anon key in the browser cannot read any table.
- We do not use Supabase realtime / PostgREST features (not needed for v1).
