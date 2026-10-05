# ADR 0002 - Progress and compliance are computed in the domain

**Status:** Accepted · 2026-10-04

## Context

Completion %, overdue status, audience resolution and reminder triggers are the core business rules. They could be
written as SQL views or computed in TypeScript.

## Decision

Repositories return plain rows (people, items + audiences, completions). The domain `LearningProgress` and
`ReminderPlanner` modules compute statuses and totals in memory.

## Consequences

- Rules live in one deep module with exhaustive unit tests; SQL stays simple CRUD.
- Expected scale (hundreds of people × ~50 items per cycle) is trivially fast in memory.
- If the firm grows by orders of magnitude, add a reporting read-model; the domain interface stays the same.
