# Project Accountants Learning Platform - Backend

REST API for the CPD / learning-compliance platform.
Node.js 20 · TypeScript · Express 5 · Clean Architecture · Supabase PostgreSQL.

## Architecture

```
src/
├── domain/            Entities, value objects, business policies, repository interfaces.
│                      No framework, database or HTTP imports.
├── application/       Use cases (one service per feature), DTOs, ports (Clock, IdentityProvider, …).
│                      Depends only on domain.
├── infrastructure/    Implementations: Postgres repositories (pg), Supabase Auth/Storage over fetch,
│                      config, clock. Implements the interfaces defined by the inner layers.
├── interfaces/http/   Express app, routes, thin controllers, zod validators, middleware, error handler.
├── shared/            Error types, constants, small utilities.
├── container.ts       Composition root (manual dependency injection).
└── main.ts            Process entry point.
```

Decisions are recorded in [docs/adr](docs/adr); domain vocabulary in [docs/GLOSSARY.md](docs/GLOSSARY.md).

## Setup

1. **Node 20.19+** (`.nvmrc`), then `npm install`.
2. **Supabase project** (supabase.com → your project):
   1. **SQL Editor → New query**: paste and run each file in `supabase/migrations/` **in filename order**
      (`…0100_init_schema`, `…0200_reference_data`, `…0300_storage_evidence_bucket`).
      Check: Table Editor shows 13 tables; Storage shows a **private** bucket `evidence`.
      (CLI alternative: `npx supabase link --project-ref <ref>` then `npx supabase db push`.)
   2. **Authentication → Sign In / Providers → Email**: enabled. Turn **off "Allow new users to sign up"** -
      accounts are created by this API (`POST /auth/register`, which applies the work-email rule), so public
      sign-up through the anon key is not needed and would bypass that rule.
   3. **Authentication → URL Configuration**: Site URL = your frontend URL (`http://localhost:5173` locally).
   4. **Project Settings → API Keys / Data API**: copy the Project URL and the **service_role / secret** key.
   5. **Connect** (top bar) → **Session pooler** connection string → put your database password in it.
3. Copy `.env.example` → `.env` and fill in `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (and `ALLOWED_EMAIL_DOMAINS`, SMTP when ready).
4. Verify: `npm run check:setup` - read-only checks of .env, database tables, auth key, storage bucket and JWT keys
   (prints pass/fail only, never secrets).
5. Run: `npm run dev` → http://localhost:4000/health should return `{"success":true,…}`.
6. Optional demo data: see below. Or sign up through the frontend, then make yourself admin once in the
   SQL Editor: `update profiles set role = 'learning_team', reporting_access = 'full' where email = 'you@…';`

### No Supabase yet?

`npm run demo` runs the real API on an in-memory database with the prototype's people and items
(pair it with `npm run dev:demo` in the frontend). Dev only.

## Scripts

| Script                        | What it does                                                 |
| ----------------------------- | ------------------------------------------------------------ |
| `npm run dev`                 | Start with auto-reload                                       |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled build                      |
| `npm test`                    | All tests (unit, integration on an in-process Postgres, API) |
| `npm run typecheck`           | Type-check source and tests                                  |

## Demo data (development only)

After the migrations and `.env` are in place:

```bash
SEED_DEMO_PASSWORD="choose-a-demo-password" npm run seed:dev
```

Creates the prototype's 8 people (sign-in accounts at `@pa-demo.test`, e.g. `apatel@pa-demo.test` = Learning Team),
their line managers, 8 learning items and sample completions. Safe to re-run; refuses to run with `NODE_ENV=production`.

## Endpoints (`/api/v1`)

| Area           | Endpoints                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth           | `POST /auth/register` · `GET /me` · `GET /lookups`                                                                                                             |
| Learning years | `GET /cycles` · `POST /cycles` · `PATCH /cycles/:id`                                                                                                           |
| Template       | `GET /items` · `GET/PUT/DELETE /items/:id` · `POST /items` · `GET /items/import/template` · `POST /items/import/preview` · `POST /items/import`                |
| Users          | `GET /users` · `POST /users` · `PATCH /users` (bulk) · `PATCH /users/:id` · `GET /users/import/template` · `POST /users/import/preview` · `POST /users/import` |
| Progress       | `GET /progress/overview` · `GET /progress/members` · `GET /progress/members/:profileId` · `GET /me/plan`                                                       |
| Evidence       | `PUT /me/completions/:itemId` (multipart) · `GET /me/completions` · `GET /completions` · `GET /completions/:id/evidence-url`                                   |
| Reminders      | `GET/PUT /reminders/settings` · `GET /reminders/candidates` · `POST /reminders/send` · `GET /reminders/log`                                                    |
| Reports        | `GET /reports/team/:kind` (log, completion, mandatory, outstanding, evidence, icaew, acca) · `GET /reports/me/:kind` (all, period, outstanding)                |

Most list endpoints accept `?cycleId=` (default: current year); reports accept `?from=&to=`.

## API conventions

- Base path `/api/v1`; `Authorization: Bearer <Supabase access token>` on every route except `POST /auth/register` and `/health`.
- Success: `{ "success": true, "data": … }`
- Error: `{ "success": false, "message": "…", "code": "SOME_CODE", "details"?: [{ "path", "message" }] }`

## Security notes

- The service-role key and database URL live only in this backend's environment.
- Every table has row-level security enabled with no policies, so the browser's anon key cannot read data directly.
- Tokens are verified against the project's JWKS; authorization is enforced server-side by the access policy.
