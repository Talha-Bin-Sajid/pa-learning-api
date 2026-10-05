# ADR 0003 - People are provisioned by email and linked to auth on sign-in

**Status:** Accepted · 2026-10-04

## Context

The Learning Team adds people (singly or by Excel import) before they ever sign in. Microsoft SSO will be added later.

## Decision

`profiles` has its own UUID and a nullable unique `auth_user_id`. Registration (and, later, the first SSO sign-in)
matches the Supabase auth user to an existing profile by lower-cased email; if none exists a Team Member profile is
created. A `status` column (`active/pending/inactive`) allows a sign-up approval queue later without schema change.

## Consequences

- No invitation emails are needed for v1.
- Switching to SSO only changes how the auth user is created; profile linking is identical.
