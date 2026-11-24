# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

PRT 数据样例管理平台 (Demo Hub): an internal platform for managing demo files, requirements, structured data descriptions, versioning and supervisor review/publish, with Feishu (Lark) login. User-facing text and docs are in Chinese. Single process: Express API + Vite-built React SPA + SQLite (`node:sqlite`, no ORM) + local-disk file storage.

## Commands

Requires Node.js 24 (uses built-in `node:sqlite`, `node --test`, `--env-file-if-exists`).

```bash
npm ci
npm run dev        # scripts/dev.mjs: API on 127.0.0.1:3100 (--watch, DEMO_MODE, DATA_DIR=.preview-data) + Vite on 5173
npm test           # node --test, serial, tests/*.test.mjs
node --test tests/auth.test.mjs                         # single file
node --test --test-name-pattern="Feishu callback" tests/auth.test.mjs   # single test
npm run build      # vite build -> dist/
npm start          # production server (reads .env if present)
docker compose up -d --build --wait   # local container on 127.0.0.1:8080
```

Before committing (per README): `npm test`, `npm run build`, `git diff --check`.

## Architecture

- `server/index.mjs` — entry; calls `createApp()`, starts listener plus background workers (notifications, requirement calendar, requirement wiki) and handles graceful shutdown.
- `server/app.mjs` — `createApp(options)` is the composition root: opens the store (`db.mjs`), wires auth, requirements, RAG search, description agent, preview, network routing, and defines most API routes. All config comes from env or can be overridden via `options` — tests rely on this.
- Permissions are enforced server-side: employee owns own data, supervisor sees team, product manager read-only over all, admin manages users. Keep checks in the server, not just the UI.
- Feishu integrations (OAuth in `auth.mjs`, bot notifications, calendar events, wiki/docs sync, Excel export) all take an injectable `fetch`; background jobs are retryable with persisted status.
- Harness integration: `harness-auth.mjs` (`POST /api/harness/exchange`, HMAC + nonce → 30-min scoped token limited to requirement/draft/upload endpoints) and `harness-sso.mjs` (Demo Hub acts as login provider for Harness center via signed redirects + one-time PKCE code). Both need `HARNESS_SHARED_SECRET` (≥32 bytes). See README sections for full contract.
- AI: `description-agent.mjs` (data description generation) and `rag.mjs` (smart search) both use DeepSeek `deepseek-v4-pro`, configured via `model-config.mjs`.
- `shared/` — pure modules imported by both server and `src/` (links, requirement owners/schedule).
- `src/` — React 19 SPA (no router lib; `App.jsx` drives views), API client in `api.js`, icons from `lucide-react`.
- Demo mode (`DEMO_MODE=true`) seeds synthetic data (`seed.mjs`, `harness-preview.mjs`) and enables role-switch login; `runtime.mjs` refuses unsafe bindings (demo login must stay on loopback, never exposed to the corporate network).

## Key conventions

- Roles (`users.roles` JSON array): `employee`, `supervisor`, `pm` (产品经理), `business` (商务), `admin`. Permission helpers (`own`, `manage`, `editAccess`, `visible`, `businessRestricted`) live at the top of `createApp` and are passed into `createRequirements` via `helpers`.
- Version status flow: `draft` → `pending` (submit to a supervisor) → `published` / `returned`; also `offline` (unpublish) and `restore`. All transitions go through `POST /api/versions/:id/actions`. Submitting or publishing requires at least one bound requirement and complete files. Requirement status: `open`, `needs_update`, `delivered`, `closed`.
- Optimistic locking: mutable rows have a `revision` column; clients send `revision`, and the server returns 409 on mismatch (`checkRevision`). Write operations go inside `tx(...)`.
- Every non-GET `/api` request must send `X-Requested-With: PRT`, a matching `Origin` and `X-CSRF-Token` (see `src/api.js`). Harness-delegated requests skip this check.
- Schema lives in `server/db.mjs` (`CREATE TABLE IF NOT EXISTS` plus ad-hoc `ALTER`/`PRAGMA table_info` migrations); some modules create their own tables, e.g. `notifications`, `requirement_calendar`, `requirement_wiki`. Preview and production data dirs are tagged in `metadata.mode` and can't be mixed.
- Background queues (notifications, calendar, wiki, exports) are DB tables with `status/attempts/next_at/error` columns and are polled by `start()`; enqueue rather than calling Feishu inline.
- Description agent supports `api` (OpenAI-compatible) or `cli` transport (spawns the `claude` CLI); RAG search falls back to local keyword ranking when no key is set or the model errors.
- API errors are Chinese user-facing messages thrown via `fail(status, message)` / `HttpError`; request bodies are validated with zod.
- Frontend has no router: `App.jsx` keeps page state and syncs it to query params (`?demo=`, `?requirement=`, `?view=`).

## Testing conventions

Tests are integration tests using `supertest` against `createApp({ dataDir: <tmpdir>, demoMode, fetch: mock, ... })`, closing `store.db` and removing the tmpdir in `t.after`. External calls (Feishu, DeepSeek) are always mocked via the injected `fetch`. Small fixtures in `tests/fixtures/` are required — keep them.

## Deployment notes

Production runs on a Windows host (see `docs/host-deployment.md`); `compose.production.yaml` is for HTTPS + Feishu deployments. Never commit `.env`, databases, uploads, backups or `dist/`. Backup/restore: `npm run backup`, `scripts/restore.mjs`; admin bootstrap: `scripts/admin.mjs`.
