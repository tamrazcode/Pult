# Pult v2 — Chat History, Fast Turns, Projects & T3-style UI

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `pult` to parity with T3 Code's workflow and responsiveness: render full multi-run thread history with a right-edge tick rail, eliminate turn/streaming bottlenecks via process pooling and event batching, add folder-backed projects with strict workspace isolation and T3-style sidebar/context menus, streamline the composer to a single minimal bar, and ship Katagami typography plus a legible Liquid Glass theme.

**Architecture:** Five phases layered on the existing Tauri 2 + React 19 stack:

- **Phase 0 (Measurement):** Instrument runtime turn stages (`RunTiming`, `run:timing`) and add an executable benchmark runner (`perf_turn` example + `scripts/perf-turn.mjs`) to baseline cold/warm turns before touching hot paths.
- **Phase 1 (Speed & Chat History):** Merge all runs of a thread in `MessagesTimeline` with `session/load` replay deduplication, add `HistoryTicks` on the right edge, replace connection-per-run with an `IdlePool`, coalesce streaming deltas in an `EventBatcher` backed by single-transaction SQLite batch inserts (`spawn_blocking`), eliminate redundant `loadInstances()` IPC calls, and throttle/memoize frontend markdown + Shiki + selectors.
- **Phase 2 (Projects, Sidebar & Context Menus):** Add SQLite v4 (`projects.pinned`), full `projects_*` CRUD, strict missing-folder errors (removing the silent global-root fallback), `tauri-plugin-dialog` folder picking, `CreateProjectDialog` & `ProjectSettingsDialog`, a T3-style project-first `Sidebar` (brand + back/forward + search/actions + project/thread stars + bottom toolbar), reusable `ContextMenu` for projects and threads, and project-aware headers/breadcrumbs.
- **Phase 3 (Visual System):** Vendor `Katagami Sans` & `Katagami Mono` (SIL OFL) replacing Inter/JetBrains Mono, add `Liquid Glass` (`data-theme="liquid"`) with `@supports` and `prefers-reduced-transparency` fallbacks plus `--panel-bg` contrast separation across all themes, rebuild `Composer` into a minimal T3 bar (single permission control inside one `⋯` overflow menu, no dead mic), and polish shell proportions.
- **Phase 4 (Acceptance):** Run full headless verification, benchmark against latency/IPC targets, execute a live built-app walkthrough, and record results in `DEVLOG.md` + `docs/screenshots/`.

**Tech Stack:** Tauri 2 (Rust, Tokio, `rusqlite`, `tauri-plugin-dialog`), React 19, TypeScript (strict), Zustand 5, TanStack Router, Tailwind CSS v4, Vitest, `cargo test` / `cargo clippy`.

**Spec & Baseline Evidence:** `README.md`, `DEVLOG.md`, `TODO.md`, and the 2026-11-14 Gemini performance audit:

- **Cold `spawn + initialize + session/new`:** mock `67–72 ms`, opencode `6.12 s` (warm OS cache `2.31 s`), codex `14.24 s` (warm `3.25 s`, without `npx -y` `1.61 s`), antigravity `17.53 s` (warm `16.04 s`).
- **Warm `session/new` on open connection:** opencode `40 ms`, codex `119 ms`, antigravity `3.29 s`.
- **Real TTFT:** antigravity `20–24 s`, opencode `2.5–10.9 s`, codex `7.2–9 s`.
- **Identified bottlenecks:** connection-per-run spawning, 1 IPC + 1 SQLite autocommit per token delta, `ReactMarkdown` + `Shiki` recreating plugins (`[remarkGfm, remarkMath]`, `[rehypeKatex]`) and re-parsing on every token, `loadInstances()` IPC on every `run_finished` / `config_options`, `DiffPanel` `useSuggestedCommitMessage` regex splitting on every token, `MessagesTimeline` calling `scrollIntoView` synchronously per delta and rendering only `activeRunForThread`, `threads_get` executing synchronous N+1 `load_events` queries.
- **Latency Targets:** Warm turn app overhead `< 10 ms` (hard acceptance `< 100 ms`), TTFT = model time + `< 50 ms`, `≤ 20–30` IPC/SQLite ops/sec under heavy streaming.

---

## Global Constraints

- **SQLite migrations are additive only:** Migration v4 in `src-tauri/src/store/migrations.rs` adds `projects.pinned INTEGER NOT NULL DEFAULT 0`. No table rewrites, no destructive column drops. Deleting a project leaves existing threads intact with `project_id = NULL` (existing `ON DELETE SET NULL` FK).
- **Zero-migration metadata where safe:** `threads.status` is `TEXT NOT NULL` with no `CHECK` constraint — `"archived"` is valid as-is (update TS `ThreadStatus` + UI filters). `Mark unread` persists as a JSON string array under `settings` key `"unread_threads"` (`unread.rs`/settings KV), auto-flagged when a non-active thread finishes a run and cleared on open.
- **Existing `~/.pult/pult.db` compatibility:** Must open and migrate v3 → v4 without data loss; startup stale-run cleanup stays intact.
- **Strict TypeScript & IPC errors:** Keep `strict: true`; all backend errors stay `PultError { code, message }`.
- **Minimal new dependencies:** Only `tauri-plugin-dialog` + `@tauri-apps/plugin-dialog` for native folder picking. Katagami fonts are committed static assets in `src/assets/fonts/` with `OFL.txt` and pinned commit SHA — not an npm package.
- **Honesty rule (zero dead controls):** Do NOT render a microphone button or any inert placeholder control until speech input exists.
- **Headless-first verification:** Automated gates (`pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy --all-targets -- -D warnings`) run headlessly in every phase; live desktop window verification happens only in Phase 4.
- **UI voice:** Direct, unslop copy; no milestone numbers or internal jargon in user-visible strings.

## Review Focus

1. **History duplication on resume:** `session/load` replays prior user/agent/tool updates over `events_rx`. If persisted into the new run while SQLite already holds prior runs, the merged timeline duplicates history. `run_turn` must drain and discard replayed transcript events while keeping session metadata (`CommandsUpdate`, `ConfigOptions`, `ModeChange`, `SessionInfo`).
2. **Pool isolation & lock hygiene:** Reused connections in `IdlePool` must match `(thread_id, instance_id, root, spawn_sig)` and `!conn.is_dead()`, drop cleanly on cancel/crash/TTL/LRU eviction/project change/provider save, and NEVER hold `inner.lock()` across `.await`.
3. **Batch ordering & monotonic `seq`:** `EventBatcher` must assign `seq` only at flush/materialization (never before coalescing adjacent deltas) and execute a barrier `flush_now()` before every `ApprovalRequest`, `ApprovalResponse`, `ElicitationRequest`, `ToolCall`, `ToolCallUpdate`, `Plan`, `ConfigOptions`, `FileChanged`, `ModeChange`, `Usage`, and `RunFinished`.
4. **Project workspace enforcement:** A thread created inside a project must use `project.root_path` (or its git worktree) as `cwd` and fs sandbox. If that folder is moved or deleted on disk, `workspace_root_for` and `threads_create` must return an explicit `PultError` (`"workspace.missing"`) — NEVER silently fall back to `~/pult-workspace`.
5. **Visual legibility & Cyrillic:** `Katagami Sans` / `Katagami Mono` must render Cyrillic cleanly; all 4 themes (including `liquid`) must pass WCAG ≥ 4.5:1 text contrast on `--canvas`, `--panel-bg`, `--chrome`, `--surface`, `--surface-raised`; `--panel-bg` must be brighter than `--canvas` in dark themes; Liquid Glass must remain readable under `prefers-reduced-transparency: reduce` and without `backdrop-filter`.

---

## Phase 0 — Measurement

### Task 1: Turn-latency instrumentation and executable benchmark

**Files:**

- Modify: `src-tauri/src/events.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/examples/perf_turn.rs`, `scripts/perf-turn.mjs`
- Test: `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- Rust struct in `src-tauri/src/events.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct RunTiming {
      pub run_id: String,
      pub thread_id: String,
      pub instance_id: String,
      pub pooled: bool,
      pub spawn_ms: u64,
      pub handshake_ms: u64,
      pub session_ms: u64,
      pub config_ms: u64,
      pub prompt_ms: u64,
      pub first_delta_ms: Option<u64>,
      pub total_ms: u64,
  }
  ```
- EventSink trait method `fn emit_run_timing(&self, timing: &RunTiming)` emitting Tauri event `"run:timing"` (in-memory telemetry only, not stored in SQLite).
- `perf_turn` Rust example (`cargo run --manifest-path src-tauri/Cargo.toml --example perf_turn -- <agent>`) dispatches 2 consecutive turns on the same thread against `mock`, `opencode`, `codex`, or `antigravity` and outputs one JSON line per turn (`turn`, `pooled`, `spawnMs`, `handshakeMs`, `sessionMs`, `promptMs`, `firstDeltaMs`, `totalMs`).
- `scripts/perf-turn.mjs` wraps `cargo run --example perf_turn` (passing `[mock|opencode|codex|antigravity]`) and formats the comparison table.

- [ ] **Step 1: Write failing test**
      In `src-tauri/src/runtime/tests.rs`, add `mock_run_emits_timing_with_first_delta`: record `RunTiming` events in `RecordingSink`, dispatch one turn against mock agent, wait for `run_finished`, assert `timings.len() == 1`, `timings[0].pooled == false`, `timings[0].handshake_ms > 0`, and `timings[0].first_delta_ms.is_some()`.
- [ ] **Step 2: Run test to verify failure**
      Run `cargo test --manifest-path src-tauri/Cargo.toml mock_run_emits_timing_with_first_delta` → FAIL (`RunTiming` / `emit_run_timing` undefined).
- [ ] **Step 3: Implement `RunTiming`, timing capture, and benchmark runner**
      Instrument `run_turn` and `resolve_session` in `src-tauri/src/runtime/mod.rs` using `std::time::Instant` around spawn, `initialize`, `session/new` or `session/load`, desired config application, `prompt` RPC start, first `AgentMessageDelta`/`AgentThoughtDelta` arrival, and run completion. Implement `src-tauri/examples/perf_turn.rs` and `scripts/perf-turn.mjs`.
- [ ] **Step 4: Run test + baseline benchmark**
      Run `cargo test --manifest-path src-tauri/Cargo.toml mock_run_emits_timing_with_first_delta` → PASS.
      Run `node scripts/perf-turn.mjs mock` and (where installed locally) `opencode` / `codex` / `antigravity`; record the pre-optimization baseline in `DEVLOG.md`.
- [ ] **Step 5: Commit**
      `feat(runtime): add per-turn RunTiming telemetry and perf-turn benchmark`

---

## Phase 1 — Speed & Chat History

### Task 2: Render full thread history across all runs and drop `session/load` replay duplicates

**Files:**

- Modify: `src/stores/runs.ts`, `src/components/chat/MessagesTimeline.tsx`
- Modify: `src-tauri/src/runtime/mod.rs` (`resolve_session`, `run_turn`)
- Test: `tests/runs-store.test.ts`, `tests/messages-timeline.test.tsx` (create), `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- `src/stores/runs.ts`:
  ```ts
  export interface TimelineRunEntry {
    run: Run;
    view: RunView;
    items: Array<{ key: string; item: ChatItem; showCaret: boolean }>;
  }
  export function threadTimelineItems(
    runs: Run[] | undefined,
    views: Record<string, RunView>,
  ): Array<{ key: string; runId: string; item: ChatItem; showCaret: boolean }>;
  ```
  - Runs are sorted by `run.idx` ascending.
  - React keys use `${run.id}:${item.type === "tool" ? `tool-${item.toolCallId}`: item.type === "compaction" ?`comp-${item.compactionId}`:`i-${index}`}` so keys never collide across runs.
  - `showCaret` is `true` ONLY on the last item of the thread when the latest active run has `view.streaming === true` (fixing the existing window-index mismatch bug `i === last` when `hiddenCount > 0`).
  - `MessagesTimeline` resets `windowSize` to `TRANSCRIPT_WINDOW` (300) ONLY when `threadId` changes (not when `runId` increments on the next message).
  - Plan, pending approval, and error/retry controls render from the latest/active run below the merged transcript.
- `src-tauri/src/runtime/mod.rs`:
  - `resolve_session` returns `struct ResolvedSession { session_id: String, resumed: bool }`.
  - Immediately after `resolve_session` succeeds with `resumed == true`, `run_turn` drains all currently buffered messages from `events_rx` (`try_recv()` loop):
    - **Discard** replayed transcript items: `UserMessage`, `AgentMessageDelta`, `AgentThoughtDelta`, `ToolCall`, `ToolCallUpdate`, `Plan`, `Compaction`, `Notice`, `Usage`.
    - **Apply/preserve** metadata updates if present: `CommandsUpdate`, `ConfigOptions`, `ModeChange`, `SessionInfo`.

- [ ] **Step 1: Write failing tests**
  - `tests/runs-store.test.ts`: two runs (`r1` finished with user+assistant, `r2` running with user+assistant delta) → `threadTimelineItems` returns all 4 items in run `idx` order with unique keys and `showCaret === true` only on item 3.
  - `tests/messages-timeline.test.tsx`: renders `r1` and `r2` messages together in DOM; dispatching a new run does not hide `r1`; windowing hides items across both runs and clicking `Earlier messages` expands the merged window.
  - `src-tauri/src/runtime/tests.rs`: `resume_session_load_drops_replayed_transcript_but_keeps_commands` — mock replays a prior `user_message` + `agent_message_chunk` + `available_commands_update` during `session/load`; assert the new run's persisted events contain NO replayed transcript items from run 1, while `commands_update` IS preserved.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/runs-store.test.ts tests/messages-timeline.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml resume_session_load_drops_replayed_transcript_but_keeps_commands` → FAIL.
- [ ] **Step 3: Implement merged timeline selector, `MessagesTimeline` refactor, and pre-session drain**
      Update `src/stores/runs.ts`, `src/components/chat/MessagesTimeline.tsx`, and `src-tauri/src/runtime/mod.rs`.
- [ ] **Step 4: Run tests**
      Run `pnpm test` and `cargo test --manifest-path src-tauri/Cargo.toml` → PASS.
- [ ] **Step 5: Commit**
      `fix(chat): render full thread history across runs and filter session/load replay`

### Task 3: Right-edge chat history tick rail (`HistoryTicks`)

**Files:**

- Create: `src/components/chat/HistoryTicks.tsx`
- Modify: `src/components/chat/MessagesTimeline.tsx`
- Test: `tests/history-ticks.test.tsx`

**Interfaces:**

- `HistoryTicks`:
  ```ts
  export interface HistoryTick {
    key: string;
    label: string; // trimmed first 80 chars of user message
    globalIndex: number; // index in unwindowed merged timeline
  }
  export function HistoryTicks(props: {
    ticks: HistoryTick[];
    activeKey: string | null;
    onJump: (tick: HistoryTick) => void;
  }): JSX.Element | null;
  ```
- Positioned on the right edge of the scrollable transcript container (`sticky` / overlay rail on the right gutter, `pointer-events-auto`, hidden when `ticks.length === 0`).
- Each user message gets a `2×10 px` (or `h-0.5 w-2.5` hairline expanding on hover/active to `w-4 bg-accent`) button with `title` / hover popover showing the 80-char preview.
- Clicking a tick when `globalIndex < hiddenCount` automatically expands `windowSize` to include `globalIndex` (`Math.max(windowSize, totalItems - globalIndex + 20)`) and, after render (`requestAnimationFrame`), scrolls `[data-history-key="<key>"]` smoothly into view (`scrollIntoView({ block: "start", behavior: "smooth" })`).
- Active tick updates on scroll by finding the topmost visible user message element in the scroll container.

- [ ] **Step 1: Write failing tests**
      In `tests/history-ticks.test.tsx`:
  - Renders 1 tick per `user` item across multiple runs (`0` ticks → renders `null`).
  - Hovering/focusing a tick displays its 80-char preview text.
  - Clicking a tick in an unwindowed transcript calls `scrollIntoView` on the matching element; clicking a tick inside the hidden older window expands `windowSize` and scrolls to the newly mounted element.
- [ ] **Step 2: Run test to verify failure**
      Run `pnpm test tests/history-ticks.test.tsx` → FAIL.
- [ ] **Step 3: Implement `HistoryTicks` and integrate into `MessagesTimeline.tsx`**
      Create `src/components/chat/HistoryTicks.tsx` and wire `data-history-key`, scroll tracking, and jump-to-hidden-window expansion in `src/components/chat/MessagesTimeline.tsx`.
- [ ] **Step 4: Run tests**
      Run `pnpm test tests/history-ticks.test.tsx tests/messages-timeline.test.tsx` → PASS.
- [ ] **Step 5: Commit**
      `feat(chat): add right-edge HistoryTicks navigation rail`

### Task 4: Idle agent process & session pool (`IdlePool`)

**Files:**

- Create: `src-tauri/src/runtime/pool.rs`
- Modify: `src-tauri/src/drivers/acp.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/lib.rs`, `fixtures/mock-acp-agent.mjs`
- Test: inline `#[cfg(test)]` in `src-tauri/src/runtime/pool.rs` + `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- `src-tauri/src/drivers/acp.rs`: expose `pub fn is_dead(&self) -> bool` checking the `AcpConn` exit/reader status atomic flag.
- `src-tauri/src/runtime/pool.rs`:
  ```rust
  pub const MAX_IDLE_CONNS: usize = 6;
  pub const IDLE_TTL: Duration = Duration::from_secs(15 * 60);

  #[derive(Debug, Clone, PartialEq, Eq)]
  pub struct SpawnSig {
      pub command: String,
      pub args: Vec<String>,
      pub env: BTreeMap<String, String>,
  }

  pub struct IdleConn {
      pub conn: Arc<AcpConn>,
      pub events_rx: UnboundedReceiver<EventKind>,
      pub client_requests_rx: UnboundedReceiver<ClientRequest>,
      pub session_id: String,
      pub instance_id: String,
      pub root: PathBuf,
      pub spawn_sig: SpawnSig,
      pub applied_config: DesiredConfigMap,
      pub applied_mode: Option<String>,
      pub last_used: Instant,
  }

  pub struct IdlePool { ... }
  ```
  Methods:
  - `take_matching(&self, thread_id: &str, instance_id: &str, root: &Path, spawn_sig: &SpawnSig) -> Option<IdleConn>`: pops entry for `thread_id`; if `instance_id`, `root`, or `spawn_sig` differ, or `conn.is_dead()`, spawns `conn.kill()` outside lock and returns `None`.
  - `park(&self, thread_id: String, entry: IdleConn)`: drops expired entries (`> IDLE_TTL`), inserts/replaces entry for `thread_id`, and if `len > MAX_IDLE_CONNS`, evicts least-recently-used entries and kills them outside the mutex lock.
  - `invalidate_thread(&self, thread_id: &str)`, `invalidate_instance(&self, instance_id: &str)`, `invalidate_root(&self, root: &Path)`, `evict_expired(&self)`, `stats(&self) -> PoolStats`.
- `run_turn` flow:
  - Try `runtime.pool.take_matching(...)` before `AcpConn::spawn`.
  - **Cache hit (`pooled = true`):** skip `spawn`, `initialize`, `session/new|load`, and skip re-sending `set_mode` / `set_config_option` for entries identical to `applied_mode` / `applied_config`. Drain any stale queued updates on `events_rx`, emit `RunTiming { pooled: true, spawn_ms: 0, handshake_ms: 0, session_ms: 0, ... }`.
  - **On normal completion** (`stop_reason` is `end_turn` / `max_tokens` / `max_turn_requests` and `!conn.is_dead()`): park `IdleConn` back into `runtime.pool` instead of calling `conn.kill()`.
  - **On cancel, error, crash, `threads_delete`, `projects_update`/`delete`, or `providers_instances_save`:** call `conn.kill()` and invalidate matching pool entries. Never hold `inner.lock()` or `pool` lock across `.await`.

- [ ] **Step 1: Write failing tests**
  - `fixtures/mock-acp-agent.mjs`: when `MOCK_SPAWN_LOG` env var is set, append one PID line on `initialize`.
  - `pool.rs` tests: LRU eviction at 7th entry kills oldest; TTL expiry drops entry; mismatching `instance_id` or `root` or `spawn_sig` invalidates and returns `None`; `is_dead() == true` drops entry.
  - `runtime/tests.rs`: two sequential dispatches on the same thread write 1 PID line to `MOCK_SPAWN_LOG` and both succeed; cancelling run 1 kills process (`pool.stats().idle == 0`); two threads keep independent sessions; saving provider config invalidates pooled entries for that instance.
- [ ] **Step 2: Run tests to verify failure**
      Run `cargo test --manifest-path src-tauri/Cargo.toml pool` → FAIL.
- [ ] **Step 3: Implement `IdlePool`, `AcpConn::is_dead`, and `run_turn` pooling + invalidation hooks**
      Create `src-tauri/src/runtime/pool.rs`, update `src-tauri/src/drivers/acp.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/ipc/mod.rs`, and `src-tauri/src/lib.rs`.
- [ ] **Step 4: Run tests + re-benchmark**
      Run `cargo test --manifest-path src-tauri/Cargo.toml` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
      Run `node scripts/perf-turn.mjs mock` and check warm turn overhead `< 100 ms` (target `< 10 ms` after Task 5).
- [ ] **Step 5: Commit**
      `perf(runtime): pool idle agent processes and sessions per thread`

### Task 5: Event batching (`EventBatcher`), batched SQLite transactions, and async `threads_get`

**Files:**

- Create: `src-tauri/src/runtime/batch.rs`
- Modify: `src-tauri/src/runtime/mod.rs`, `src-tauri/src/store/events.rs`, `src-tauri/src/store/runs.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/events.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/runEvents.ts`, `src/stores/runs.ts`
- Test: `src-tauri/src/runtime/batch.rs`, `src-tauri/src/store/tests.rs`, `tests/runs-store.test.ts`

**Interfaces:**

- `src-tauri/src/runtime/batch.rs`:
  ```rust
  pub const BATCH_WINDOW: Duration = Duration::from_millis(40);
  pub const BATCH_MAX_ITEMS: usize = 32;

  pub struct EventBatcher {
      run_id: String,
      next_seq: i64,
      pending: Vec<EventKind>,
      ...
  }
  ```
  - `push(&mut self, kind: EventKind)`:
    - Coalesces adjacent `EventKind::AgentMessageDelta { delta }` with `AgentMessageDelta` and `EventKind::AgentThoughtDelta { delta }` with `AgentThoughtDelta`.
    - Immediate barrier (`flush_now()`) BEFORE pushing non-coalesceable boundary events (`ApprovalRequest`, `ApprovalResponse`, `ElicitationRequest`, `ToolCall`, `ToolCallUpdate`, `Plan`, `ConfigOptions`, `FileChanged`, `ModeChange`, `Usage`, `RunFinished`) — ensuring text preceding a tool/approval/finish is always assigned lower `seq` and flushed first.
  - `flush_now(&mut self) -> Vec<Event>`: materializes `pending` into `Vec<Event>` assigning strictly contiguous `seq = self.next_seq; self.next_seq += 1` at flush time only.
- `src-tauri/src/store/events.rs`:
  - `pub fn append_events_batch(&self, events: &[Event]) -> Result<(), PultError>` inserts all events inside one `conn.transaction()`, invoked via `tokio::task::spawn_blocking`.
  - `pub fn load_thread_events(&self, thread_id: &str) -> Result<Vec<Event>, PultError>` single `JOIN` query ordered by `r.idx ASC, e.seq ASC`.
- `src-tauri/src/ipc/mod.rs`:
  - `threads_get` becomes `async` and runs store queries (`get_thread`, `list_runs`, `load_thread_events`, `list_queue`) inside `tokio::task::spawn_blocking`.
- Tauri event & frontend:
  - Backend emits `"run:events"` with `RunEventsPayload { run_id: String, events: Vec<AppEvent> }` (`#[serde(rename_all = "camelCase")]`).
  - `useRunsStore.receiveRunEventsBatch(runId: string, events: AppEvent[])` folds the entire batch in one Zustand `set()` call.

- [ ] **Step 1: Write failing tests**
  - `batch.rs`: 5 adjacent `AgentMessageDelta`s collapse into 1 event with concatenated text and `seq = 1`; pushing `ApprovalRequest` flushes pending deltas first (`seq = 1`) then approval (`seq = 2`); pushing 40 distinct non-coalescing events flushes at cap 32 with strictly monotonic `seq`.
  - `store/tests.rs`: `append_events_batch` inserts 100 events in 1 transaction; `load_thread_events` returns events across 2 runs in `(r.idx, e.seq)` order.
  - `tests/runs-store.test.ts`: `receiveRunEventsBatch` produces the exact `RunView` state as sequential `receiveRunEvent` calls with a single subscriber notification.
- [ ] **Step 2: Run tests to verify failure**
      Run `cargo test --manifest-path src-tauri/Cargo.toml batch` and `pnpm test tests/runs-store.test.ts` → FAIL.
- [ ] **Step 3: Implement `EventBatcher`, `append_events_batch`, `load_thread_events`, async `threads_get`, `run:events`, and `receiveRunEventsBatch`**
      Wire into `run_turn` loop (`tokio::select!` with 40 ms interval tick + barrier flushes on finish/cancel/approval).
- [ ] **Step 4: Run tests + stream benchmark**
      Run `cargo test`, `cargo clippy`, `pnpm test` → PASS.
      Verify 1000-chunk mock stream performs `≤ 30` IPC/SQLite transactions per second and warm overhead drops `< 10 ms`.
- [ ] **Step 5: Commit**
      `perf(streaming): coalesce deltas, batch IPC/SQLite writes, and parallelize threads_get`

### Task 6: Stop redundant `loadInstances()` IPC refreshes

**Files:**

- Modify: `src/stores/ui.ts`, `src/lib/runEvents.ts`, `src/lib/ipc.ts`, `src/lib/types.ts`
- Modify: `src-tauri/src/events.rs`, `src-tauri/src/runtime/mod.rs`
- Test: `tests/run-events.test.ts` (create)

**Interfaces:**

- `useUiStore.patchInstance(instanceId: string, patch: Partial<Pick<InstanceInfo, "configOptions" | "modes" | "promptImage" | "loadSession" | "authMethods" | "authHint" | "status">>)`.
- Backend `AgentCapsPayload { instance_id, prompt_image, load_session, modes, config_options, auth_methods, auth_hint }` emitted on Tauri event `"agent:caps"` ONLY when `cache_capabilities` / `cache_auth_state` detects an actual change from cached values.
- `src/lib/runEvents.ts`:
  - `config_options` event calls `useUiStore.getState().patchInstance(runInstanceId, { configOptions })` directly in memory — ZERO `loadInstances()` calls.
  - `run_finished` updates thread status/unread and no longer calls `loadInstances()`.
  - `"agent:caps"` listener calls `patchInstance(...)`.

- [ ] **Step 1: Write failing test**
      In `tests/run-events.test.ts`: mock `providersInstancesList`; feed `config_options` and `run_finished` events through `runEvents` handlers; assert `useUiStore.getState().instances[0].configOptions` updated and `providersInstancesList` called `0` times.
- [ ] **Step 2: Run test to verify failure**
      Run `pnpm test tests/run-events.test.ts` → FAIL (`providersInstancesList` called on `run_finished` / `config_options`).
- [ ] **Step 3: Implement `patchInstance`, `"agent:caps"`, and `runEvents.ts` cleanup**
- [ ] **Step 4: Run tests**
      Run `pnpm test` and `cargo test` → PASS.
- [ ] **Step 5: Commit**
      `perf(ipc): update instance capabilities via targeted events instead of loadInstances`

### Task 7: Frontend streaming optimizations (Markdown, Shiki, Timeline, Selectors, DiffPanel)

**Files:**

- Modify: `src/components/chat/Markdown.tsx`, `src/components/chat/MessagesTimeline.tsx`, `src/components/chat/ComposerControls.tsx`, `src/components/diff/DiffPanel.tsx`, `src/stores/runs.ts`
- Test: `tests/markdown.test.tsx` (create), `tests/messages-timeline.test.tsx`, `tests/diff-panel.test.tsx` (create)

**Interfaces:**

- `src/components/chat/Markdown.tsx`:
  - Hoist `const REMARK_PLUGINS = [remarkGfm, remarkMath]` and `const REHYPE_PLUGINS = [rehypeKatex]` to module level (eliminates unified pipeline recreation on every render).
  - Accept `streaming?: boolean`; when `streaming` is true, throttle markdown re-parsing with a `120 ms` leading/trailing timer (flush immediately when `streaming` flips to `false`).
  - Track open fenced code blocks (`\`\`\`...`without closing fence): render plain`<pre><code>`while fence is open or actively streaming; trigger Shiki highlighting only after a fence closes (or`250 ms` after the last delta).
  - Replace eager 19-language Shiki bundle preload with on-demand `highlighter.loadLanguage(lang)` cached in a `Map<string, Promise<void>>`.
- `src/components/chat/MessagesTimeline.tsx`:
  - Wrap `ChatItemRow` in `React.memo` with custom props comparator (`prev.item === next.item && prev.showCaret === next.showCaret`).
  - Maintain `isAtBottomRef` via container `onScroll` listener (`scrollHeight - scrollTop - clientHeight < 48`); auto-scroll via `requestAnimationFrame` only when `isAtBottomRef.current === true` (user scrolling up to read history is never hijacked by streaming deltas).
- `src/components/chat/ComposerControls.tsx`:
  - Replace `const views = useRunsStore((s) => s.viewsByRun)` with point selectors:
    - `useRunsStore((s) => (activeRunId ? s.viewsByRun[activeRunId]?.configOptions : undefined))`
    - `useRunsStore((s) => (activeRunId ? s.viewsByRun[activeRunId]?.modeId : undefined))`
- `src/stores/runs.ts` & `src/components/diff/DiffPanel.tsx`:
  - Add `suggestedCommit?: string` on `RunView`; compute it once inside `applyRunEvent` when `event.kind === "run_finished"` (instead of `useSuggestedCommitMessage` subscribing to `viewsByRun` and running regex splits on every streamed delta).

- [ ] **Step 1: Write failing tests**
  - `tests/markdown.test.tsx`: streaming open code fence does NOT call Shiki `codeToHtml`; closing the fence triggers lazy `loadLanguage` + highlight; module-level plugin arrays preserve identity across renders.
  - `tests/messages-timeline.test.tsx`: `ChatItemRow` from run 1 does not re-render when run 2 appends a delta; scrolling up sets `isAtBottom = false` and skips `scrollIntoView`.
  - `tests/diff-panel.test.tsx`: `suggestedCommit` stays `undefined` while streaming deltas arrive and populates only upon `run_finished`.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/markdown.test.tsx tests/messages-timeline.test.tsx tests/diff-panel.test.tsx` → FAIL.
- [ ] **Step 3: Implement all 4 frontend optimizations**
- [ ] **Step 4: Run tests**
      Run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `perf(ui): optimize streaming markdown, lazy Shiki, memoized timeline, and point selectors`

---

## Phase 2 — Projects, Sidebar & Context Menus

### Task 8: Project schema v4, backend CRUD, strict workspace errors, archive & unread support

**Files:**

- Modify: `src-tauri/src/store/migrations.rs` (v4), `src-tauri/src/store/records.rs`, `src-tauri/src/store/mod.rs`, `src-tauri/src/store/threads.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/store/projects.rs`
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`
- Test: `src-tauri/src/store/tests.rs`, `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- Migration v4 (`src-tauri/src/store/migrations.rs`):
  ```sql
  ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ```
- `ProjectRecord` (`src-tauri/src/store/records.rs`):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct ProjectRecord {
      pub id: String,
      pub name: String,
      pub root_path: String,
      pub color: Option<String>,
      pub worktree_strategy: String,
      pub pinned: bool,
      pub created_at: i64,
  }
  ```
- `src-tauri/src/store/projects.rs`: `list_projects`, `get_project`, `create_project`, `update_project(id, name?, color?, worktree_strategy?, pinned?)`, `delete_project`.
- IPC commands (`src-tauri/src/ipc/mod.rs` + registered in `src-tauri/src/lib.rs`):
  - `projects_list() -> Vec<ProjectRecord>`
  - `projects_create(name: String, root_path: String, color: Option<String>, worktree_strategy: Option<String>) -> ProjectRecord` (validates `root_path` is an existing directory, canonicalizes it)
  - `projects_update(id: String, name: Option<String>, color: Option<String>, worktree_strategy: Option<String>, pinned: Option<bool>) -> ProjectRecord` (emits `"projects:update"`)
  - `projects_delete(id: String) -> ()` (deletes project, threads stay with `project_id = NULL`, emits `"projects:update"` + `"threads:update"`).
- `threads_create`: if `project_id` is `Some(pid)`:
  - Verify project exists via `store().get_project(&pid)` and its `root_path` is an existing directory (`PultError::with_code("workspace.missing", ...)` if missing).
  - Default `workspace` to `project.root_path` (unless explicit valid `workspace` provided) and apply `worktree` according to parameter or `project.worktree_strategy == "worktree"`.
- **Strict workspace enforcement (`workspace_root_for` in `src-tauri/src/runtime/mod.rs`):**
  - If `thread.workspace` is `Some(ws)` and `!Path::new(ws).is_dir()` → return `Err(PultError::with_code("workspace.missing", format!("Project or thread folder not found: {ws}")))` (remove silent fallback to global root!).
  - If `thread.workspace` is `None` and `thread.project_id` is `Some(pid)` → look up project; if missing or `!Path::new(&proj.root_path).is_dir()`, return `Err(PultError::with_code("workspace.missing", ...))`; else use `proj.root_path`.
  - Only when BOTH `thread.workspace == None` and `thread.project_id == None` use `self.workspace_root()`.
- Frontend types (`src/lib/types.ts`): add `Project`, extend `ThreadStatus` with `"archived"`, add `projectsList`, `projectsCreate`, `projectsUpdate`, `projectsDelete` to `src/lib/ipc.ts`.

- [ ] **Step 1: Write failing tests**
  - `store/tests.rs`: v3 → v4 migration preserves existing threads; `create_project` / `list_projects` / `update_project` / `delete_project` round-trip; deleting project sets thread's `project_id` to `None` without deleting thread; `threads_create` with `project_id` sets `workspace == project.root_path`.
  - `runtime/tests.rs`: thread whose `workspace` (or project `root_path`) was removed from disk fails dispatch immediately with `code == "workspace.missing"` instead of running in `~/pult-workspace`.
- [ ] **Step 2: Run tests to verify failure**
      Run `cargo test --manifest-path src-tauri/Cargo.toml projects` and `workspace_missing` → FAIL.
- [ ] **Step 3: Implement migration v4, `ProjectRecord`, `store/projects.rs`, IPC handlers, strict `workspace_root_for`, and TS wrappers**
- [ ] **Step 4: Run tests**
      Run `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `pnpm typecheck` → PASS.
- [ ] **Step 5: Commit**
      `feat(projects): add SQLite v4 project CRUD and strict workspace resolution`

### Task 9: Native folder picker, `CreateProjectDialog`, and `ProjectSettingsDialog`

**Files:**

- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `package.json`, `src/lib/ipc.ts`
- Create: `src/stores/projects.ts`, `src/components/projects/CreateProjectDialog.tsx`, `src/components/projects/ProjectSettingsDialog.tsx`
- Test: `tests/project-dialog.test.tsx`

**Interfaces:**

- Dependencies: add `tauri-plugin-dialog = "2"` to `src-tauri/Cargo.toml`, register `.plugin(tauri_plugin_dialog::init())` in `src-tauri/src/lib.rs`, add `"dialog:default"` to `src-tauri/capabilities/default.json`, add `@tauri-apps/plugin-dialog` to `package.json`.
- `src/lib/ipc.ts`: `export async function pickFolder(title?: string): Promise<string | null>` wrapping `@tauri-apps/plugin-dialog`'s `open({ directory: true, multiple: false, title })`.
- `src/stores/projects.ts`:
  ```ts
  export const PROJECT_COLORS = ["#346bf1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#06b6d4"];
  export function useProjectsStore... // projects, selectedProjectId, loadProjects, createProject, updateProject, togglePin, deleteProject
  ```
- `CreateProjectDialog.tsx`:
  - Opens native folder picker (`pickFolder("Choose project folder")`), pre-fills `name` from folder basename and deterministic `color` from `PROJECT_COLORS` hash of `name`.
  - Allows editing name, choosing color swatch, picking default worktree mode (`Direct folder` vs `Git worktree`), displays read-only `rootPath`, surfaces `PultError` inline.
  - On submit: calls `useProjectsStore.getState().createProject(...)`, selects the new project, and navigates to `/chat` (ready to start a thread in that project).
- `ProjectSettingsDialog.tsx`:
  - Edits `name`, `color`, `worktreeStrategy`, `pinned`, offers `Copy path` (via `navigator.clipboard.writeText`), and `Delete project` with inline confirmation (calls `deleteProject`, keeping threads with `projectId: null`).

- [ ] **Step 1: Write failing tests**
      In `tests/project-dialog.test.tsx`:
  - Clicking "Choose folder" invokes `pickFolder()`, populates path & basename into `name` input.
  - Cancelling folder picker makes zero `projectsCreate` IPC calls.
  - Submitting `CreateProjectDialog` calls `projectsCreate` with trimmed name, `rootPath`, and color.
  - Submitting `ProjectSettingsDialog` calls `projectsUpdate`; Delete requires two clicks (confirm) before calling `projectsDelete`.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/project-dialog.test.tsx` → FAIL.
- [ ] **Step 3: Wire `tauri-plugin-dialog`, implement `useProjectsStore`, `CreateProjectDialog`, and `ProjectSettingsDialog`**
- [ ] **Step 4: Run tests**
      Run `pnpm test tests/project-dialog.test.tsx`, `pnpm typecheck`, `cargo check --manifest-path src-tauri/Cargo.toml` → PASS.
- [ ] **Step 5: Commit**
      `feat(projects): add tauri-plugin-dialog folder picker and project dialogs`

### Task 10: T3 Code-style Sidebar + Unread state + Footer toolbar

**Files:**

- Modify: `src/components/layout/Sidebar.tsx`, `src/components/layout/Topbar.tsx`, `src/stores/threads.ts`, `src/stores/ui.ts`, `src/lib/runEvents.ts`, `src/lib/types.ts`
- Test: `tests/sidebar.test.tsx` (create), `tests/threads.test.ts`

**Interfaces:**

- `src/stores/threads.ts`:
  - Track `unreadIds: string[]` persisted via existing `settingsGet("unread_threads")` / `settingsSet("unread_threads", ...)` (plus `markUnread(id, unread)` and auto-mark on `run_finished` in `runEvents.ts` when `activeThreadId !== threadId`, auto-clear on opening thread).
  - Pure grouping & filter selector:
    ```ts
    export type SidebarFilter = "all" | "unread" | "pinned" | "working" | "archived";
    export interface SidebarGroup {
      project: Project | null; // null = "No project" (rendered last)
      threads: Thread[];
    }
    export function buildSidebarGroups(
      projects: Project[],
      threads: Thread[],
      opts: { query: string; filter: SidebarFilter; unreadIds: Set<string> },
    ): SidebarGroup[];
    ```
    - Projects sorted `(Number(b.pinned) - Number(a.pinned)) || a.name.localeCompare(b.name)`.
    - Threads within each group sorted `(Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt)`.
    - `"archived"` threads excluded unless `filter === "archived"`.
    - `"No project"` group appears last only when it has matching threads.
- `Sidebar.tsx` layout matching T3 Code:
  1. **Brand & nav header:** Pult mark + `pult` title on left; `Back` (`ArrowLeft`) and `Forward` (`ArrowRight`) navigation buttons on right.
  2. **Search + quick actions row:** Inline `Search` input (`filter` query) + icon buttons for **Filter** popover (`all | unread | pinned | working | archived`), **New project** (`FolderPlus` opening `CreateProjectDialog`), and **New thread** (`SquarePen` / `Plus` navigating to `/chat` in selected project).
  3. **Project & thread tree:**
     - **Remove** `SHELVES`, `SHELF_HINTS`, `SHELF_TARGET`, drag-to-shelf handlers, giant `New thread` button, and footer `New thread with workspace…` button.
     - Each project row shows collapse chevron, colored initial badge (first 1–2 letters of `project.name` over `project.color`), project name, optional star icon if `pinned`, and inline `+` (`New thread in project`) on hover.
     - Each nested thread row shows status dot (`working`/`waiting`) or unread dot, title (or inline rename input), relative time (`2m`, `1h`), and hover/pinned star toggle.
  4. **Bottom toolbar:** `Settings` (moved from `Topbar.tsx`), `Pull requests`, `Usage`, `Refresh` (reloads projects + threads + instances).
  5. Background token: `bg-panel` (`--panel-bg`), slightly brighter than `--canvas`.
- `Topbar.tsx`: remove the `Settings` gear button (Settings now lives in the sidebar footer; `Mod+,` command palette shortcut stays active).

- [ ] **Step 1: Write failing tests**
      In `tests/sidebar.test.tsx`:
  - Pinned projects sort above unpinned projects; pinned threads sort above unpinned threads inside each project; `"No project"` group renders last.
  - Legacy shelf headings (`drafts`, `snoozed`, `settled`, `pinned`) and `"New thread with workspace"` button do NOT exist in DOM.
  - Search input filters threads across groups; collapsed project hides its nested threads; unread dot renders for `unreadIds`; archived threads hidden by default and visible under `"archived"` filter.
  - Clicking footer `Settings`, `Pull requests`, `Usage`, and `Refresh` triggers navigation / store reload; `Topbar` no longer renders the settings gear.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/sidebar.test.tsx` → FAIL.
- [ ] **Step 3: Implement `buildSidebarGroups`, `unreadIds`, `Sidebar.tsx` rebuild, and `Topbar.tsx` update**
- [ ] **Step 4: Run tests**
      Run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(sidebar): rebuild sidebar with T3-style project groups, stars, search, and footer toolbar`

### Task 11: Reusable right-click `ContextMenu` for projects and threads

**Files:**

- Create: `src/components/ui/ContextMenu.tsx`
- Modify: `src/components/layout/Sidebar.tsx`, `src/components/chat/ChatHeader.tsx`
- Test: `tests/context-menu.test.tsx` (create), `tests/sidebar.test.tsx`

**Interfaces:**

- `src/components/ui/ContextMenu.tsx`:
  ```ts
  export interface ContextMenuItem {
    id: string;
    label: string;
    icon?: ReactNode;
    shortcut?: string;
    danger?: boolean;
    disabled?: boolean;
    confirmLabel?: string; // two-step inline confirmation for Delete
    onSelect: () => void;
  }
  export function ContextMenu(props: {
    x: number;
    y: number;
    items: Array<ContextMenuItem | "separator">;
    onClose: () => void;
  }): JSX.Element;
  ```
  - Clamps `(x, y)` inside viewport bounds, sets `data-escape-layer` (so Escape closes menu instead of cancelling an active run), closes on outside click or container scroll, supports `ArrowUp`/`ArrowDown`/`Enter`/`Escape` keyboard navigation.
  - Items with `confirmLabel` (e.g., `Delete`) switch inline to `Confirm delete?` on first click/Enter and only call `onSelect()` on the second click/Enter.
- **Exact Project context menu items:**
  1. `New thread` (creates/opens `/chat` scoped to this project)
  2. `Copy path` (copies `project.rootPath`)
  3. `Pin` / `Unpin` (toggles `project.pinned`)
  4. `Project settings` (opens `ProjectSettingsDialog`)
  5. `separator`
  6. `Delete` (`danger: true, confirmLabel: "Confirm delete"`, deletes project leaving threads with `projectId: null`)
- **Exact Thread context menu items:**
  1. `Pin` / `Unpin` (toggles `thread.pinned`)
  2. `Settle` (`status = "settled"`)
  3. `Snooze` (`status = "snoozed"`)
  4. `Rename` (switches sidebar thread row into inline `<input>` edit mode)
  5. `Mark unread` / `Mark read` (toggles `unreadIds`)
  6. `Copy path` (copies `thread.workspace ?? project?.rootPath`)
  7. `Project settings` (opens `ProjectSettingsDialog` for `thread.projectId`, disabled if `projectId === null`)
  8. `Archive` (`status = "archived"`)
  9. `separator`
  10. `Delete` (`danger: true, confirmLabel: "Confirm delete"`, cancels active run if running & deletes thread)

- [ ] **Step 1: Write failing tests**
      In `tests/context-menu.test.tsx` & `tests/sidebar.test.tsx`:
  - Right-clicking a project renders exact items: `New thread`, `Copy path`, `Pin`, `Project settings`, `Delete`.
  - Right-clicking a thread renders exact items: `Pin`, `Settle`, `Snooze`, `Rename`, `Mark unread`, `Copy path`, `Project settings`, `Archive`, `Delete`.
  - First click on `Delete` reveals inline confirmation without deleting; second click deletes.
  - `ArrowDown` + `Enter` selects menu item; `Escape` closes without firing run cancel.
  - `Pin` on project/thread calls store and reorders groups/rows.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/context-menu.test.tsx tests/sidebar.test.tsx` → FAIL.
- [ ] **Step 3: Implement `ContextMenu.tsx` and wire project/thread menus in `Sidebar.tsx`**
- [ ] **Step 4: Run tests**
      Run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(ui): add keyboard-accessible context menus for projects and threads`

### Task 12: Project-aware `ChatHeader`, `ChatColumn`, `/chat` selection, and breadcrumbs

**Files:**

- Modify: `src/components/chat/ChatHeader.tsx`, `src/components/chat/ChatColumn.tsx`, `src/lib/breadcrumbs.ts`, `src/routes/chat.tsx`, `src/stores/ui.ts`, `src/stores/threads.ts`, `src/components/chat/Composer.tsx`
- Test: `tests/breadcrumbs.test.ts`, `tests/chat-header.test.tsx` (create)

**Interfaces:**

- `src/lib/breadcrumbs.ts`:
  ```ts
  export function resolveBreadcrumbs(
    pathname: string,
    threads: Thread[],
    projects?: Project[],
    selectedProjectId?: string | null,
  ): Crumb[];
  ```
  - Thread route with project → `pult / <ProjectName> / <ThreadTitle>`; without project → `pult / <ThreadTitle>`.
  - `/chat` with selected project → `pult / <ProjectName> / New thread`.
- `ChatHeader.tsx`: renders colored project badge + project name when thread (or `/chat` draft) belongs to a project, plus thread title and worktree badge.
- `Composer.tsx` `/chat` dispatch path: passes `useProjectsStore.getState().selectedProjectId` (and `project.rootPath` as `workspace` + `project.worktreeStrategy === "worktree"`) into `threadsCreate(...)`, clearing or keeping project selection consistent so the newly created thread immediately inherits the project's folder and appears nested under that project in the sidebar.

**Added requirement (user, 2026-11-14):** the `/chat` empty state is a first-run screen: centered Pult mark (chevron + bar), heading “What should we do in Pult?”, one-line hint, deterministic ASCII halftone backdrop, and the workspace strip + composer inline under the heading (not pinned to the bottom). Implemented ahead of this task in `src/components/chat/NewChatEmptyState.tsx` (`NewThreadOptionsStrip.tsx` extracted); Task 12 must keep it project-aware.

- [ ] **Step 1: Write failing tests**
  - `tests/breadcrumbs.test.ts`: thread under project `"pult"` returns `[pult, pult-proj, ThreadTitle]`.
  - `tests/chat-header.test.tsx`: header displays project badge + name; creating a thread from `/chat` while a project is selected passes `projectId` and `workspace = project.rootPath`.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/breadcrumbs.test.ts tests/chat-header.test.tsx` → FAIL.
- [ ] **Step 3: Implement project-aware header, `/chat` creation wiring, and breadcrumbs**
- [ ] **Step 4: Run tests**
      Run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(chat): bind new threads, chat header, and breadcrumbs to active project`

---

## Phase 3 — Visual System

### Task 13: Katagami Sans & Katagami Mono typography (replacing Inter & JetBrains Mono)

**Files:**

- Create: `src/assets/fonts/KatagamiSans[wght].ttf`, `src/assets/fonts/KatagamiSans-Italic[wght].ttf`, `src/assets/fonts/KatagamiMono[wght].ttf`, `src/assets/fonts/KatagamiMono-Italic[wght].ttf`, `src/assets/fonts/OFL.txt`, `src/styles/fonts.css`
- Modify: `src/styles/tokens.css`, `src/styles/index.css`, `src/main.tsx`, `src/components/terminal/TerminalPane.tsx`, `package.json`
- Test: `tests/fonts.test.ts` (create)

**Interfaces:**

- Download from `https://github.com/Kevin-Liu-01/Katagami` (`fonts/sans/`, `fonts/mono/`, `OFL.txt`) and record the exact `main` commit SHA in `src/styles/fonts.css` header comment.
- `src/styles/fonts.css`:
  ```css
  /* Katagami (SIL OFL 1.1) — pinned commit <SHA> */
  @font-face {
    font-family: "Katagami Sans";
    src: url("../assets/fonts/KatagamiSans[wght].ttf") format("truetype-variations");
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
  }
  /* + Italic, Katagami Mono normal & Italic */
  ```
- `src/styles/tokens.css`:
  - `--font-family-ui: "Katagami Sans", system-ui, -apple-system, sans-serif;`
  - `--font-family-mono: "Katagami Mono", ui-monospace, monospace;`
- `src/components/terminal/TerminalPane.tsx`: update XTerm `fontFamily` to `"'Katagami Mono', ui-monospace, monospace"`.
- Remove `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` imports from `src/main.tsx` and remove both packages from `package.json`.

- [ ] **Step 1: Write failing test**
      In `tests/fonts.test.ts`:
  - Assert `src/assets/fonts/OFL.txt` and all 4 Katagami TTF files exist on disk (`> 0` bytes).
  - Assert `src/styles/tokens.css` defines `"Katagami Sans"` and `"Katagami Mono"`, and contains no `"Inter Variable"` or `"JetBrains Mono Variable"`.
  - Assert `src/main.tsx`, `package.json`, and `src/components/terminal/TerminalPane.tsx` contain no `@fontsource-variable/inter` or `JetBrains Mono`.
- [ ] **Step 2: Run test to verify failure**
      Run `pnpm test tests/fonts.test.ts` → FAIL.
- [ ] **Step 3: Download Katagami fonts + `OFL.txt` (pinning SHA), add `fonts.css`, update tokens/imports/`TerminalPane.tsx`/`package.json`**
- [ ] **Step 4: Run tests**
      Run `pnpm test tests/fonts.test.ts` and `pnpm build` → PASS.
- [ ] **Step 5: Commit**
      `feat(ui): replace Inter and JetBrains Mono with Katagami Sans and Katagami Mono`

### Task 14: Liquid Glass theme (`data-theme="liquid"`) and brighter `--panel-bg` across themes

**Files:**

- Create: `src/styles/themes/liquid.css`
- Modify: `src/styles/tokens.css`, `src/styles/themes/light.css`, `src/styles/themes/graphite.css`, `src/styles/index.css`
- Modify: `src/stores/settings.ts`, `src/lib/theme.ts`, `src/lib/commands.ts`, `src/routes/settings.appearance.tsx`
- Test: `tests/theme-contrast.test.ts`

**Interfaces:**

- Add `--panel-bg` token to `tokens.css` (`#0c0c0c`, brighter than `--canvas: #000000`), `graphite.css` (`#141414`, brighter than `--canvas: #0d0d0d`), `light.css` (`#f7f7f8` / `#fafafa`), and `liquid.css` (`#151821` opaque test-base + `--panel-glass` translucent layer). Expose `--color-panel: var(--panel-bg)` in `src/styles/index.css` `@theme inline`.
- `src/styles/themes/liquid.css`:
  - Defines all opaque hex tokens in `:root[data-theme="liquid"]` (e.g., `--canvas: #0b0e14`, `--panel-bg: #141923`, `--chrome: #121722`, `--surface: #171d2b`, `--surface-raised: #1e2638`, `--text-primary: #f4f6fb`, `--text-secondary: #b4bdd0`, `--text-tertiary: #8d99b0`) plus glass layer tokens (`--glass-panel`, `--glass-surface`, `--glass-blur: 18px`, `--glass-saturate: 1.35`, `--glass-border: rgba(255, 255, 255, 0.12)`).
  - Applies `.glass-surface` / `[data-theme="liquid"]` backdrop blur ONLY inside `@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))` and disables transparency/blur inside `@media (prefers-reduced-transparency: reduce)`.
- `src/stores/settings.ts`: `export type ThemeName = "dark" | "light" | "graphite" | "liquid";`.
- `src/lib/theme.ts`: add `{ id: "liquid", label: "Liquid Glass" }` to `THEMES`.
- `src/lib/commands.ts`: add `theme.liquid` command.
- `src/routes/settings.appearance.tsx`: add Liquid Glass theme preview card.
- `tests/theme-contrast.test.ts`: extend `THEMES` to include `["liquid", LIQUID]`, include `"--panel-bg"` in the `bg` contrast loop (`≥ 4.5:1`), and assert `relativeLuminance(tokens["--panel-bg"]) > relativeLuminance(tokens["--canvas"])` for dark themes (`dark`, `graphite`, `liquid`).

- [ ] **Step 1: Write failing tests**
      Update `tests/theme-contrast.test.ts` to test 4 themes (`dark`, `light`, `graphite`, `liquid`), check contrast on `--panel-bg`, and assert dark theme `--panel-bg` luminance exceeds `--canvas`.
- [ ] **Step 2: Run test to verify failure**
      Run `pnpm test tests/theme-contrast.test.ts` → FAIL (`liquid.css` / `--panel-bg` missing).
- [ ] **Step 3: Implement `liquid.css`, `--panel-bg` across themes, glass fallbacks, and theme picker/commands**
- [ ] **Step 4: Run tests**
      Run `pnpm test tests/theme-contrast.test.ts`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(themes): add Liquid Glass theme and brighter panel contrast tokens`

### Task 15: Minimal T3-like composer with single permission control & one overflow menu

**Files:**

- Modify: `src/components/chat/Composer.tsx`, `src/components/chat/ComposerControls.tsx`
- Test: `tests/composer.test.tsx`

**Interfaces:**

- Visual & structural layout of `Composer.tsx`:
  - Compact container (`rounded-(--radius-lg)`, subtle hairline border + `--composer-tint` glass surface, reduced padding so single-line height is compact — `textarea` `min-h-[38px] pt-2.5 pb-1 text-sm` instead of bloated `pt-3.5 text-base`).
  - Bottom toolbar row (`flex items-center gap-1.5 px-2.5 pb-2 pt-1`):
    - **Left:** Attach button using `<Paperclip size={15} />` (capability-gated when `!imageCapable` with informative title; no `Plus` icon), plus compact `ComposerStatusLine` (branch / workspace / decision alert).
    - **Right:**
      1. **Model selector pill** (compact, always visible): displays active model name from the `model` `SessionConfigOption` (or selected agent `displayName` if the agent exposes no `model` option); clicking opens a compact model/agent switcher popover.
      2. **Single `⋯` overflow menu (`ComposerOverflowMenu`):** houses all secondary controls in one clean dropdown (`aria-label="Composer options"`):
         - **Effort / Thought level** & remaining non-mode `SessionConfigOption` pickers (hiding any option with `option.id === "mode" || option.category === "mode"` so mode never duplicates!).
         - **Session Mode** (`AgentModePicker` modes list, when advertised by the agent).
         - **Permissions** (the **ONLY** permission control — `supervised` / `auto_edit` / `auto` / `full_access` selector; `ModePill` is completely removed from the always-visible bottom bar).
         - **Agent instance** (`AgentPicker` list + `Manage agents…` link).
      3. **Single round send/stop button** (`h-8 w-8 rounded-full`): renders `Square` (Stop run) when `runActive && !value.trim() && chips.length === 0`, otherwise `ArrowUp` (Send/Queue message). Remove `<Kbd>Enter</Kbd>` clutter from the bottom bar.
  - **Honesty check:** Do NOT add a microphone button.
  - Preserve slash commands (`/`), `@` file mentions, image paste/drop/chips, queue strip, `Enter` send, `Shift+Enter` newline, and `A/S/D` approval shortcuts.

- [ ] **Step 1: Write failing tests**
      In `tests/composer.test.tsx`:
  - Renders `Paperclip` attach button, model pill, `⋯` overflow button, and round send/stop button.
  - Assert at most ONE permission label (`Full access` / `Supervised` / etc.) appears when overflow is opened, and ZERO permission/mode pills appear duplicated on the bar (even when the agent sends a `configOptions` entry with `id: "mode"` or `category: "mode"`).
  - Assert NO microphone button (`aria-label*="mic" / "voice"`) is rendered.
  - Opening `⋯` shows Effort/config options, Session mode, Permission mode, and Agent switcher; picking works and closes cleanly on Escape.
  - `Enter` sends, `Shift+Enter` inserts newline, `/` and `@` popups still work.
- [ ] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/composer.test.tsx` → FAIL.
- [ ] **Step 3: Refactor `Composer.tsx` & `ComposerControls.tsx`**
- [ ] **Step 4: Run tests**
      Run `pnpm test tests/composer.test.tsx`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(composer): rebuild minimal T3-style composer with single overflow menu`

### Task 16: Shell polish to match T3 Code

**Files:**

- Modify: `src/components/layout/Sidebar.tsx`, `src/components/layout/RightPanel.tsx`, `src/components/layout/Topbar.tsx`, `src/components/chat/ChatHeader.tsx`, `src/styles/index.css`
- Test: `tests/shell-layout.test.tsx` (create)

**Interfaces:**

- Both `Sidebar` (`aside` left) and `RightPanel` (`aside` right) use `bg-panel` (`--panel-bg`), brighter than center `bg-canvas`, with `border-border-subtle` hairlines.
- Standardize control row heights (`h-7` / `h-8`, `28–32 px`), UI text `12 px` (`text-sm`), `rounded-(--radius-sm)` (`6 px`) controls, compact `h-10` or `h-11` topbar/header rhythm, and accent reserved strictly for primary actions and active selection.
- `RightPanel` tabs (`Diff`, `Files`, `Terminal`) adopt sleek pill/underline styling matching T3 Code.

- [ ] **Step 1: Write failing tests**
      In `tests/shell-layout.test.tsx`: assert `Sidebar` and `RightPanel` root `<aside>` elements apply `bg-panel` (not `bg-canvas` / `bg-chrome`), while main chat column retains `bg-canvas`.
- [ ] **Step 2: Run test to verify failure**
      Run `pnpm test tests/shell-layout.test.tsx` → FAIL.
- [ ] **Step 3: Apply shell polish across `Sidebar.tsx`, `RightPanel.tsx`, `Topbar.tsx`, `ChatHeader.tsx`, `index.css`**
- [ ] **Step 4: Run tests**
      Run `pnpm test`, `pnpm typecheck`, `pnpm lint` → PASS.
- [ ] **Step 5: Commit**
      `feat(ui): polish shell panels, spacing, and borders to match T3 Code`

---

## Phase 4 — Acceptance

### Task 17: Full verification, performance gate, and live walkthrough

**Files:**

- Modify: `DEVLOG.md`
- Create/Update: `docs/screenshots/*.png`

- [ ] **Step 1: Run all headless static & test gates**
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] **Step 2: Run performance benchmarks and verify targets**
  - `node scripts/perf-turn.mjs mock` (plus `opencode`, `codex`, `antigravity` if available in environment):
    - Warm turn app overhead `< 10 ms` (hard ceiling `< 100 ms`).
    - TTFT delta over raw CLI model time `< 50 ms`.
    - 1000-chunk mock stream produces `≤ 30` IPC events/s and `≤ 30` SQLite write transactions/s.
  - Record before/after comparison table in `DEVLOG.md`.
- [ ] **Step 3: Live desktop walkthrough (`pnpm tauri build` or `pnpm tauri dev`)**
      Verify in the real window:
  1. Multi-turn chat shows complete history across all runs; restarting app + resuming via `session/load` produces zero duplicate messages.
  2. History tick rail appears on the right; hover shows snippet; click jumps to older user message (including expanding hidden window).
  3. Create project via native folder picker → create thread inside project → agent executes inside that project's `root_path` → deleting/moving folder surfaces explicit error (`workspace.missing`).
  4. Sidebar matches T3 Code (header, back/forward, search/filter/new-project/new-thread, project groups with colored initials, stars reorder projects & threads, footer Settings/PRs/Usage/Refresh).
  5. Right-click context menus work for both projects and threads (including Rename, Mark unread, Archive, inline-confirmed Delete).
  6. Minimal composer has single permission control inside `⋯`, model pill outside, paperclip left, round send/stop, no dead mic.
  7. Katagami Sans/Mono renders Latin + Cyrillic cleanly; Liquid Glass theme passes visual inspection with brighter side panels and clear contrast.
  8. Capture updated screenshots into `docs/screenshots/` and summarize results in `DEVLOG.md`.
- [ ] **Step 4: Commit**
      `docs: record v2 perf benchmark results, walkthrough notes, and screenshots`

---

## Backlog — agent-generated images in pult (user request, 2026-11-14)

Goal: when an agent (first target: Codex using its `imagegen` skill) generates an image, pult shows the image inline in the thread instead of an empty tool-output JSON.

Approach:
1. Extend the ACP projection: when a tool output or agent message contains an image content block, emit a dedicated `image_artifact { path?, data?, mimeType, toolCallId? }` event instead of burying it in raw JSON.
2. Codex fallback: detect local image paths in tool output/raw JSON (`.png/.jpg/.jpeg/.webp/.gif`) that resolve inside the thread workspace or pult home; read via a size-capped Tauri command (e.g. 20 MB) and render inline.
3. UI: `ToolRow` or a new `ImageArtifact` timeline item renders a thumbnail with click-to-open/full-size, copy path, and graceful fallback when the file is gone.
4. Security: resolve canonical paths only, reject paths outside the workspace/pult home, cap bytes and dimensions, never fetch remote URLs automatically.
5. Tests: projection fixture with an image content block; Codex-style tool JSON with a temp image path; rejection of an outside-workspace path; missing file fallback.

Out of scope until a real agent emits images: annotation/editing, galleries across threads, remote URL rendering.

---

## Out of scope

- Speech-to-text / voice input (and therefore any microphone button in the composer).
- Full-page project settings route (covered by `ProjectSettingsDialog` modal instead).
- Agent `logout`, git checkpoint rollback UI, persistent PR status cache, or `tauri-specta` auto-codegen migration.
- Code signing, auto-updater hosting, or macOS/Linux packaging.
- Replacing Shiki core or removing KaTeX.

## Definition of done

1. Every thread renders its complete multi-run history; app restarts and `session/load` resumes never duplicate prior messages; `HistoryTicks` navigates to any user turn.
2. Warm turns skip process spawn, handshake, and `session/new`; warm overhead meets `< 10 ms` target (`< 100 ms` hard gate); streaming batches keep SQLite/IPC `≤ 30 ops/sec` and UI stays smooth.
3. Projects can be created from native folder selection, configured, starred, nested in the sidebar, and strictly scoped to their `root_path` (explicit error when missing).
4. Sidebar and context menus match the T3 Code structure and exact item lists, with working inline confirmations and keyboard navigation.
5. Katagami Sans & Mono (SIL OFL) replace Inter & JetBrains Mono; Liquid Glass is selectable with accessibility/transparency fallbacks; side panels are brighter than the center canvas; contrast tests pass across all 4 themes.
6. Composer is a single compact input + bottom row with one model pill, one `⋯` overflow menu containing the single permission control, paperclip attach, round send/stop, and zero dead controls.
7. All headless gates (`typecheck`, `lint`, `pnpm test`, `cargo test`, `cargo clippy`), benchmarks, and the live walkthrough are green and documented.
