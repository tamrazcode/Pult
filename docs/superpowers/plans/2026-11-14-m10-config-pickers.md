# M10 — Typed Config Options & Composer Pickers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick the model, thought level and any other ACP `configOptions` (select flat/grouped, boolean) from the composer before, during and between runs, remember the pick per thread, and record the run's actual model/effort.

**Architecture:** Type the ACP `SessionConfigOption` shapes with lenient deserialization (old `pult.db` rows keep loading), add `AcpConn::set_config_option`, cache options at preflight/handshake/updates, and mirror the proven M9 mode flow: `thread_config:<id>` in the settings KV, `ThreadDetail.desiredConfig`, apply before `session/prompt`, never fail the send when the agent rejects a value.

**Tech Stack:** Tauri 2 (Rust, Tokio, rusqlite, serde), React 19, TypeScript strict, zustand, Tailwind v4, Vitest + Testing Library, cargo test/clippy.

**Spec:** README.md, DEVLOG.md (M9 entry), TODO.md (model picker, reasoning effort), protocol/acp-schema.json (`SessionConfigOption`, `SessionConfigSelect`, `SessionConfigBoolean`, `SetSessionConfigOptionRequest`, `ClientSessionCapabilities.configOptions`).

**Status 2026-11-14:** Tasks 1–5 done (`43097d6` … `77c6821`), review fix pass in `6f0cbaf`, docs in DEVLOG/CHANGELOG. Gates: cargo 100/100, vitest 98/98, clippy/typecheck/lint clean. No GUI/Playwright pass.

## Global Constraints

- No SQLite migrations: per-thread picks live in `settings` under `thread_config:<threadId>` as `Record<string, string | boolean>`.
- Old `pult.db` event rows with `configOptions: null`/unknown types must deserialize without error (skip invalid items).
- TypeScript stays strict; IPC errors keep `PultError { code, message }`.
- No new dependencies; no GUI launch — verification is `cargo test`, `cargo clippy`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Review Focus

1. **Old/unknown config options:** a stored `null`, a future `type: "slider"`, or a half-written option must not break transcript loading.
2. **Wire shape:** string `select` values serialize without `type`; boolean values must serialize `{"type":"boolean","value":true}`.
3. **Stale picks across providers:** a model chosen for provider A must not fail provider B's run; invalid values are ignored (warn), the prompt still goes out.
4. **`/chat` isolation:** a pick made before a thread exists applies to the new thread once and is cleared; an existing thread never borrows it.
5. **Picker Esc:** closing an option popover must not cancel the running turn.

---

### Task 1: Typed protocol shapes + `AcpConn::set_config_option`

**Files:**

- Modify: `src-tauri/src/protocol/types.rs`, `src-tauri/src/events.rs`, `src-tauri/src/drivers/acp.rs`
- Test: inline `#[cfg(test)]` in the same files

**Interfaces:**

- `ConfigOptionValue`: untagged `String(String) | Bool(bool)`.
- `SessionConfigSelectOption { value, name, description?, meta? }`, `SessionConfigSelectGroup { group, name, options, meta? }`, `SessionConfigSelectOptions`: untagged flat/grouped.
- `SessionConfigOption { id, name, description?, category?, meta?, #[serde(flatten)] kind }` with `kind` tagged by `type`: `select { currentValue, options }` | `boolean { currentValue }`.
- `deserialize_config_options` helper: null → `[]`, per-item skip of invalid/unknown types.
- `NewSessionResult.config_options: Vec<SessionConfigOption>`, `LoadSessionResult.config_options: Vec<SessionConfigOption>`, `SessionUpdate::ConfigOptionUpdate { config_options: Vec<...> }`, `EventKind::ConfigOptions { options: Vec<...> }`.
- `SetConfigOptionParams` serializes `{sessionId, configId, value}` and only adds `"type": "boolean"` for booleans.
- `ClientCapabilities.session.configOptions.boolean = {}` (new optional `ClientSessionCapabilities`).
- `AcpConn::set_config_option(&self, session_id, config_id, value) -> Result<SetConfigOptionResult, DriverError>` calling `session/set_config_option`.
- `SetConfigOptionResult { config_options: Vec<SessionConfigOption>, meta? }`.

- [ ] **Step 1: Write failing tests**
  - `config_options_parse_flat_grouped_boolean_and_skip_unknown`: JSON with flat select, grouped select, boolean, one `type: "slider"`; expect 3 parsed; `null` → `[]`.
  - `set_config_option_params_serialize_select_and_boolean`: string has no `type`; bool serializes `{"type":"boolean","value":true}`.
  - `client_capabilities_advertises_boolean_config_options`.
  - Update the acp projection test fixture to typed options.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml config_option` → FAIL.
- [ ] **Step 3: Implement** types, lenient helper, capability, params, driver method.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml protocol::types drivers::acp events` → PASS.
- [ ] **Step 5: Commit** `feat(acp): typed session config options and set_config_option`.

---

### Task 2: Mock agent serves config options; driver golden test

**Files:**

- Modify: `fixtures/mock-acp-agent.mjs`, `src-tauri/src/drivers/golden.rs`

**Interfaces:**

- `session/new`/`session/load` return three options: `model` (select, grouped Recommended: `mock-fast`/`mock-pro`; Legacy: `mock-v1`, current `mock-fast`), `thought_level` (flat low/medium/high, current medium), `web_search` (boolean false).
- `session/set_config_option` validates id/value (select value must exist in flat or groups; boolean requires `type: "boolean"`), returns `-32602` otherwise, and replies `{configOptions}` after updating state; switching to `mock-v1` narrows `thought_level` to low/medium.

- [ ] **Step 1: Write failing golden test** `golden_config_options_new_session_and_set_config_option`: three options after `session/new`; setting thought level returns updated current; boolean true works; bogus value returns RPC `-32602`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml golden_config_options` → FAIL.
- [ ] **Step 3: Implement** the mock handlers without breaking existing goldens.
- [ ] **Step 4: Run** `cargo test --manifest-path src-tauri/Cargo.toml drivers::` → PASS.
- [ ] **Step 5: Commit** `test(fixtures): config options in the mock ACP agent`.

---

### Task 3: Runtime cache, desired config, run record, IPC

**Files:**

- Modify: `src-tauri/src/runtime/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- `InstanceInfo.config_options: Vec<SessionConfigOption>`; `CachedCaps.config_options`; `PreflightReport.config_options`; preflight caches `fresh.modes` + `fresh.config_options`.
- `DesiredConfigMap = HashMap<String, ConfigOptionValue>`; `AgentRuntime::desired_config(thread_id)` reads `thread_config:<id>` (invalid JSON → empty).
- `AgentRuntime::set_config_option(thread_id, config_id, value)`: persists, applies to the live conn if any, updates cached options from the response, emits `ConfigOptions` into the active run; RPC errors warn + notice, never fail.
- `dispatch` reads desired config, fills `RunRecord.model` (category/id `model`) and `.effort` (`thought_level` / `reasoning_effort`), passes the map to `RunTask`.
- `run_turn` applies valid desired entries after session resolution and mode, before prompt; invalid/missing → warn + notice, prompt continues; refreshes cache from each response.
- `ThreadDetail.desired_config: DesiredConfigMap`; `runs_dispatch(..., config_options: Option<DesiredConfigMap>)` merges before send; new `runs_set_config_option(thread_id, config_id, value)` command.

- [ ] **Step 1: Write failing runtime tests**
  - `preflight_caches_modes_and_config_options`.
  - `set_config_option_before_run_persists_and_applies_on_next_mock_run`: model `mock-pro`, thought `high` → `run.model`/`run.effort` set; config option events end with the picked values.
  - `invalid_desired_config_does_not_fail_prompt`: bogus model → run finishes (`end_turn`), not `failed`.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml config_option` → FAIL.
- [ ] **Step 3: Implement** runtime/IPC/lib changes; never hold the inner lock across `.await`.
- [ ] **Step 4: Run** `cargo test` + `cargo clippy --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `feat(runtime): per-thread config options applied before the prompt`.

---

### Task 4: Frontend types, IPC, store

**Files:**

- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/threadLoad.ts`, `src/lib/runEvents.ts`, `src/stores/runs.ts`
- Test: `tests/runs-store.test.ts`

**Interfaces:**

- TS mirrors the Rust types: `ConfigOptionValue`, select option/group, `SessionConfigOption` union; `InstanceInfo.configOptions`, `PreflightReport.configOptions`, `ThreadDetail.desiredConfig`, event `{kind:"config_options"; payload:{options: SessionConfigOption[]}}`.
- `runsDispatch(..., mode?, configOptions?)`; `runsSetConfigOption(threadId, configId, value)`.
- `RunView.configOptions?: SessionConfigOption[]`; `applyRunEvent` stores the latest list.
- Store: `desiredConfigByThread`, `setDesiredConfig`, `clearDesiredConfig`, `hydrateThread(..., desiredMode?, desiredConfig?)`, `dropThreadState` clears it.
- `runEvents`: on `config_options`, refresh `loadInstances()` so dynamic option lists reach the pickers.

- [ ] **Step 1: Failing tests** `applies config_options into RunView.configOptions`; `stores desiredConfig per thread and drops it on delete`.
- [ ] **Step 2: Run** `pnpm vitest run tests/runs-store.test.ts` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm vitest run tests/runs-store.test.ts && pnpm typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(ui): config option types and per-thread desired config`.

---

### Task 5: Composer pickers + provider/diagnostics status

**Files:**

- Modify: `src/components/chat/ComposerControls.tsx`, `src/components/chat/Composer.tsx`, `src/routes/settings.providers.tsx`, `src/routes/settings.diagnostics.tsx`
- Test: `tests/composer.test.tsx`

**Interfaces:**

- `isGroupedSelectOptions`, `flattenSelectOptions`, `pickerConfigValue(option, activeRun, liveOptions, desired)` (desired only when valid → live value while running → option current), `configForSend(desired, threadId?)` (`/chat` key never borrowed by an existing thread).
- `ConfigOptionPickers({threadId})`: pills for select (group headers supported; backdrop `data-escape-layer`; Esc preventDefault) and boolean toggles (`aria-pressed`); pick writes `setDesiredConfig(threadId ?? "", ...)` and calls `runsSetConfigOption` when the thread exists.
- Composer order: config pills → mode → agent → permission. On `/chat` send, pass pending config once and clear `""`.
- Providers: `Connected` accepts `info.configOptions.length > 0`; diagnostics shows the option count.

- [ ] **Step 1: Failing tests** `keeps /chat config options out of existing threads`; `falls back when a desired value is invalid`; `renders grouped/boolean pickers and Esc closes without cancelling`.
- [ ] **Step 2: Run** `pnpm vitest run tests/composer.test.tsx` → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Full gates** `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit** `feat(composer): model and thought-level pickers`.

---

## Out of scope

- Sign-in/`authenticate` flow and auth PTY (M11).
- `/usage` page.
- Antigravity detection.
- GUI window / Playwright runs.

## Definition of done

1. `select` (flat/grouped) and `boolean` options match the pinned schema; old DB rows load.
2. Mock + golden + runtime tests cover apply-before-prompt, run record fields, invalid values.
3. Picks persist per thread, apply once from `/chat`, never leak, never fail a send, survive restarts via `ThreadDetail.desiredConfig`.
4. Esc closes a picker without cancelling the run.
5. All five gates green.
