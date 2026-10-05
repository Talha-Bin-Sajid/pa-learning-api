# ADR 0004 - One application service per feature

**Status:** Accepted · 2026-10-04

## Context

Clean Architecture is often implemented as one class per use case, which produces dozens of shallow files.

## Decision

Each feature has one application service (e.g. `LearningItemsService` with `list/create/update/archive`), depending
only on repository interfaces and ports. Controllers stay thin and call a single service method.

## Consequences

Deeper modules and better locality; tests target the service interface. A service is split only when it grows
unrelated responsibilities.
