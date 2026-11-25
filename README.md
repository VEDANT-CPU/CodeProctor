# CodeProctor

**CodeProctor** is a real-time coding assessment, integrity telemetry, and session timeline playback platform built on **DeepSpace** (Cloudflare Workers, Hono, React + Vite, SQLite-backed Durable Objects, WebSockets, built-in Auth/RBAC, and DeepSpace integrations).

It pairs a distraction-free candidate assessment workspace with a proctor/reviewer monitoring and timeline playback workflow—emphasizing deterministic state reconstruction, explainable browser-level telemetry signals, and honest disclosure of browser/OS monitoring boundaries.

---

## Key Capabilities

* **Role-Based Access Control (`candidate` & `proctor`):** Maps DeepSpace auth/roles to domain roles and enforces permissions and session ownership on the server/Worker and Durable Object layer rather than relying solely on frontend route hiding.


* **Assessment Lifecycle & Curated Test Runner:** Supports creating, starting, running curated test suites in a time-limited browser Worker, submitting, and expiring timed-out (`timed_out`) sessions across `pending`, `active`, `submitted`, and `timed_out` states.


* **Sequence-Ordered Telemetry & Snapshots:** Assigns a session-scoped monotonic sequence number (`seq`) and client timestamp (`clientTimestamp`) alongside server receive time (`serverReceivedAt`), with offline buffering, ordered reconnect flushes (`isOfflineFlush`), and idempotent ingestion keyed by `(sessionId, seq)`.


* **Deterministic Timeline Reconstruction & Incident Aggregation:** Reconstructs code state and active flags at any sequence or timestamp cursor from snapshots plus ordered events/deltas, and aggregates raw telemetry into auditable incidents (such as paste after tab absence, focus flicker clusters, and idle gap followed by a burst).


* **Proctor Timeline Scrubber, Annotations, Dispositions & AI Briefs:** Enables proctors to scrub timelines, inspect evidence anchored to `(seq, timestamp)`, record annotations and final review dispositions (`unreviewed`, `clear`, `needs_review`, `flagged`), and request on-demand, citation-linked AI incident briefs as a triage aid.



---

## Monitoring Boundaries & Scope

CodeProctor operates strictly at the **browser and application telemetry layer**. It does **not** provide OS/kernel/browser-extension lockdown, webcam/microphone monitoring, or screen recording. Integrity signals and AI incident briefs are designed as **human review and triage aids**, not ground-truth proof of misconduct.

---

## Project Structure

* `.github/` & `.claude/` — DeepSpace skill files and assistant configuration


* `public/` — Static assets


* `src/domain/` — Pure TypeScript domain types, RBAC/lifecycle guards, actor mapping, telemetry ordering, timeline reconstruction, incident aggregation, review/citation types, and test runner logic


* `src/schemas/` & `src/schemas.ts` — Collection schemas (`assessment-sessions`, `telemetry-events`, `code-snapshots`, `proctor-annotations`, `users`, `admin`) registered for RecordRoom


* `src/actions/` — Guarded Worker action handlers and action registry (`src/actions/index.ts`)


* `src/server/` — HTTP, action, and realtime/WebSocket route setup plus server-side `ActorContext` resolution


* `src/ai/` — DeepSpace AI agent, chat routes, and tools for on-demand incident briefs


* `src/hooks/` & `src/lib/` — Client hooks (such as `useActorContext`), telemetry collection/queueing, and Worker action client helpers


* `src/components/` & `src/pages/` — Navigation, UI primitives, landing page, protected lobby (`/sessions`), and session workspace (`/sessions/[sessionId]`)


* `tests/` — Playwright smoke, API, and collaboration tests


* `worker.ts` & `wrangler.toml` — Cloudflare Worker entrypoints, Durable Object bindings, and configuration


* `AGENTS.md` — Product and architecture requirements for CodeProctor



---

## Development & Verification

Common repository scripts (see `package.json` for exact definitions):

* **Unit tests:** `npm run test:unit`


* **Type checking:** `npm run type-check`


* **Production build:** `npm run build`


* **Linting:** `npx eslint ...`



Before deploying, inspect generated build artifacts (such as `dist/codeproctor_skeleton/.dev.vars`) to ensure no unintended secrets are included.
