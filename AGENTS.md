# AGENTS.md — CodeProctor

## Project Overview

**CodeProctor** is a real-time coding assessment, integrity telemetry, and session timeline playback platform built on **DeepSpace** (Cloudflare Workers, Hono, React + Vite, SQLite-backed Durable Objects, WebSockets, built-in Auth/RBAC, and DeepSpace integrations).

- **Candidate View:** Distraction-free coding assessment workspace with problem prompt, code editor, curated test execution/submission, offline-buffered telemetry (`focus`/`blur`, paste bursts, edit cadence, reconnects), and clear disclosure of browser-level monitoring boundaries.
- **Proctor / Reviewer View:** Live multi-session monitor with deterministic incident aggregation (grouping noisy raw signals into actionable integrity flags), snapshot + sequence-ordered timeline scrubbing, and proctor-authored annotations and dispositions.

---

## Submission & Evaluation Guardrails (Non-Negotiable)

- **Hard Deadline:** **Wednesday, November 25, 2026 at 11:59 PM Eastern Time** (~4-day build sprint).
- **Primary Goal:** Ship a deployed, rock-solid core path with sound architectural judgment and real understanding of DeepSpace—never sacrifice working reliability for feature bloat.

### Build Exercise Criteria

1. **Sensible Scope for the Sprint Window:** Prioritize an end-to-end working core (create/join session $\rightarrow$ live coding + telemetry ingestion $\rightarrow$ live proctor monitor + deterministic timeline playback and human review). Document unfinished edges honestly in the final writeup.
2. **Use at Least Three DeepSpace Integrations / Platform Primitives:**
   - Do **not** reimplement platform primitives (auth, real-time sync/Durable Objects, storage, integration proxies, scheduled jobs, or AI helpers) without a documented reason.
   - Explicitly track which DeepSpace integrations were used, why they added value, and why additional integrations were intentionally excluded.
3. **Technical Depth Over Wrapper Glue:**
   - Avoid "prompt-wrapped logs" or trivial CRUD.
   - Technical depth lives in: **monotonic sequence ordering (`seq`)**, **periodic snapshot + delta state reconstruction**, **deterministic burst/anomaly grouping**, **offline queue flush on reconnect**, and **role-based access control (Candidate vs. Proctor)**.
4. **Code Clarity & Secret Hygiene:**
   - Keep modules small, typed, readable, and easy to explain or modify live.
   - Never hardcode API keys, tokens, or secrets in source files; use DeepSpace secrets/environment bindings and platform integration proxies.
5. **Agent Accountability & Verification Log:**
   - Maintain clear notes on what AI agents generated vs. what was manually verified, fixed, or redesigned so the final writeup accurately explains the main tradeoff, agent contributions, and human verification steps.

### Live Coding Session Readiness

Every file and abstraction written by an agent must be clean enough for the applicant to:

- Explain the end-to-end data flow and modify business rules live.
- Read error logs, form a hypothesis, and test a fix methodically.
- Demonstrate deliberate direction and verification of AI-generated code.

---

## Core Architecture & Domain Rules

### 1. Roles & Access Control (RBAC)

- **`candidate`:** Can view assigned problem prompt, edit code, run tests, submit final solution, and append telemetry/snapshot events _only_ to their own active session. Cannot read proctor notes, integrity flags, or other candidates' sessions.
- **`proctor`:** Can create assessments/sessions, view all active and completed sessions in real time, scrub timeline snapshots, add review annotations, trigger AI incident summaries, and mark final review dispositions.
- Enforce role checks on the server/Worker and Durable Object layer—never rely solely on frontend route hiding.

### 2. Event-Sourced Timeline & Telemetry Model

- **Deterministic Ordering:** Every client telemetry event and code snapshot must carry a session-scoped monotonic sequence number (`seq`) and client timestamp, validated against server receive time.
- **Snapshot + Delta Reconstruction:**
  - Save periodic full code snapshots (e.g., every 30s, on test run, and on final submit) alongside lightweight telemetry events (`FOCUS_LOST`, `FOCUS_RESTORED`, `LARGE_PASTE`, `TEST_RUN`, `CONNECTION_LOST`, `CONNECTION_RECOVERED`).
  - Timeline scrubbing must deterministically reconstruct code state and active flags at any timestamp/sequence index.
- **Offline Buffering & Idempotency:**
  - Buffer unsent events in the candidate client during brief network disconnects and flush in `seq` order upon reconnect.
  - Ingestion endpoints must be idempotent by `(sessionId, seq)` so retries never duplicate events or skew integrity flags.

### 3. Deterministic Integrity Signal Aggregation

- Raw browser events are noisy. Aggregate raw telemetry into structured **Incidents** using explicit, explainable rules for human review:
  - _Example:_ `PASTE_AFTER_TAB_ABSENCE` (tab hidden $> 15\text{s}$ followed by paste $> 120$ chars within $10\text{s}$).
  - _Example:_ `FOCUS_FLICKER_CLUSTER` ($\ge 4$ blur/focus transitions within $20\text{s}$).
  - _Example:_ `IDLE_GAP_THEN_BURST` (extended inactivity followed by sudden large code insertion).
- **Honest Boundaries:** Never claim OS-level lockdown or absolute cheating detection. UI copy and documentation must accurately describe browser-level telemetry signals for human review.

### 4. Purposeful DeepSpace Integrations (Target $\ge 3$)

Use native DeepSpace capabilities across the stack:

1. **DeepSpace Auth & Role-Based Permissions:** Authenticate candidates and proctors; enforce strict session ownership and reviewer privileges.
2. **Real-Time State & Durable Objects / Live Sync:** Stream live candidate status, code snapshots, and incident alerts to the proctor dashboard without manual polling.
3. **DeepSpace AI Integration:** The general DeepSpace Agent/chat remains available for assistant tasks. Incident assessment stays deterministic and human-reviewed; AI-generated incident briefs are intentionally excluded so the review UI does not present generated summaries as evidence.
4. **Additional Native Integration (e.g., Scheduled Cleanup/Session Timeout Sweep or Notification/Webhook Integration):** Automatically expire timed-out assessments or notify reviewers when high-severity incidents or submissions occur.

---

## Explicit Scope Cuts (Do NOT Build)

To protect the 4-day deadline, agents must **not** introduce:

- Full DOM/CSS session recording (`rrweb` / `MutationObserver` video-style replay).
- Webcam/microphone video streaming or computer-vision gaze/face detection models.
- Browser extensions, desktop/kernel lockdown agents, or multi-language untrusted Docker/VM code execution sandboxes (keep test execution deterministic and tightly scoped, e.g., sandboxed JS/TS test runner or curated assertion harness).
- Unrequested multi-provider OAuth suites or bloated analytics dashboards.

---

## Agent Workflow & Verification Rules

1. **Plan Before Coding:** State the files to touch, data schema impacts, and edge cases before generating multi-file changes.
2. **Small, Diffable Changes:** Keep TypeScript types strict (`no any` where avoidable), share schemas between frontend and Worker, and keep functions modular.
3. **Verify Every Critical Path:**
   - Test candidate $\rightarrow$ proctor live sync across two browser sessions/roles.
   - Test offline disconnect + reconnect flush (verify `seq` ordering and idempotency).
   - Test unauthorized cross-role API requests (candidate attempting proctor endpoints).
   - Test timeline scrubbing across snapshots, pastes, and test runs.
4. **Record Verification Notes:** Whenever fixing a bug or adjusting AI-generated logic (race conditions, schema mismatches, auth checks), leave a brief note in `NOTES.md` or commit messages so the final writeup accurately captures what the agent built vs. what the applicant verified and changed.
