# ADR 0005 - Automatic evidence verification (AI reads, policy decides)

**Status:** Accepted · 2026-10-05

## Context

Every uploaded certificate needs checking against the learning item: the right person, the same course (wording
may differ), a sensible date and enough hours. Reviewing every file by hand does not scale, and staff could upload an
unrelated document, someone else's certificate or an edited one.

## Decision

```
upload → evidence_checks row (queued) → background worker → AI model reads file + claim
       → structured JSON (validated) → firm policy (deterministic) → verified | flagged
       → Learning Team approves / rejects (manual, always wins)
```

- **The AI only reads and compares.** It returns a fixed JSON shape (`EvidenceAnalysis`): what the document is, the
  name/title/provider/date/hours it shows, match results, visible signs of editing and a confidence. Output is
  validated with zod; anything malformed is treated as unknown.
- **The firm's rules decide** (`domain/services/evidence-policy.ts`, pure and unit-tested): not a certificate, name not
  confirmed, title not the same subject, clear provider mismatch, certificate date in the future / before the
  learning year / more than `AI_DATE_TOLERANCE_DAYS` from the date entered, fewer hours than required, editing signs,
  the exact same file used elsewhere (SHA-256), or low confidence → **flagged** with plain-English reasons.
  Otherwise **verified** (`review_source = 'ai'`).
- **The AI never rejects and never overrides a person.** Only the Learning Team can reject (with a reason), which makes
  the item outstanding again. HR can see results but not decide.
- **Provider-agnostic port** (`EvidenceAnalyzer`); Gemini (`@google/genai`) is the adapter, chosen for cost and native
  PDF/image reading. The document is passed as untrusted data and the system prompt tells the model to ignore any
  instructions inside it.
- **Queue in Postgres** (`evidence_checks`, `FOR UPDATE SKIP LOCKED`), retries with back-off for temporary errors,
  stale-job recovery, and superseding when a file is replaced. Uploads never wait for the model.
- Off by default (`AI_VERIFICATION_ENABLED`); without it evidence simply waits for manual review.

## Consequences

- Most genuine certificates are cleared automatically; reviewers focus on the flagged ones with the reasons in front
  of them.
- No AI can promise to catch every forgery. A convincing fake for the right course and name can pass; the SHA-256
  check only catches exact re-use. Manual spot checks remain sensible for high-stakes items.
- Real certificates are personal data sent to Google: use a paid (billing-enabled) key, whose data is not used for
  training, and record it in the firm's data-processing register.
- Cost is tokens per check (a one-page certificate is typically a few thousand input tokens on a Flash model,
  well under a cent); token counts are stored on each check.

## Addendum (2026-10-06) - "counts for the person, confirmed for compliance"

- **Completed** = submitted and not rejected (flagged or unchecked evidence still counts, so AI mistakes and outages
  never penalise staff). **Confirmed** = completed and the evidence is verified (AI or person), or no file was needed.
- Staff see *Submitted* / *Under review* until confirmed; dashboards and every Excel export show completed and
  confirmed separately (`confirmed`, `underReview`, `confirmedPct`, an *Evidence* column, *Evidence Confirmed* in the
  ICAEW/ACCA logs).
- Reminders never chase work that is only under review; a rejection triggers a reminder the next morning with the
  reason; the Learning Team gets a Monday digest when evidence has waited more than 5 days (deduplicated through
  `notification_log`) and a dashboard banner.
