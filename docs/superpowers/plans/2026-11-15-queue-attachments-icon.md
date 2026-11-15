# Queue Actions, All-File Attachments & Build Icon Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> **Authorship & Execution Split:** Gemini authors failing tests first and verifies failure; DeepSeek implements production changes and runs verification.

## User Remarks Status

- [x] **(a) Composer underlay must be full-size/uniform (done):** Composer outer underlay fills the full composer card uniformly.
- [x] **(b) App icon stale: `build.rs` must rerun when `icons/icon.ico` changes (done):** `src-tauri/build.rs` invalidates on `icons/icon.ico` changes so rebuilt executables pick up updated icons.
- [x] **(c) Attachments always interactive and all file types (done):** `Composer` keeps `<label aria-label="Attach files">` always interactive regardless of `promptImage`, accepting images (when capable) and arbitrary text files up to 5 MB.
- [ ] **(d) Queue rows need Steer, pencil Edit inline, and drag reorder:** Remaining work below.

---

## Remaining Implementation Tasks for (d)

### Task 1: Backend Queue Store (`src-tauri/src/store/queue.rs`)

- Add `Store::update_queue_item_text(&self, item_id: &str, text: &str) -> Result<(), PultError>` updating only the target row; return an error if `0` rows affected (unknown `item_id`).
- Add `Store::reorder_queue_items(&self, thread_id: &str, queue_ids: &[String]) -> Result<(), PultError>` verifying every id belongs to `thread_id` (erroring on unknown id) and persisting the new order so `list_queue` and `pop_queue_head` return items in that exact order.
- Add `Store::move_queue_item_to_head(&self, thread_id: &str, item_id: &str) -> Result<(), PultError>` placing `item_id` before all other queued items for `thread_id` (erroring on unknown `item_id`).

### Task 2: Runtime Steer & IPC Surface (`src-tauri/src/runtime/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`)

- Add `AgentRuntime::steer(&self, thread_id: &str, queue_id: &str) -> Result<(), PultError>`:
  1. Call `self.store.move_queue_item_to_head(thread_id, queue_id)?`.
  2. Call `self.emit_queue_updated(thread_id)`.
  3. If `self.active_run_for(thread_id)` is `Some(run_id)`, call `self.cancel(&run_id)?` so `finalize_run` -> `auto_dispatch_queue` pops the steered head item next.
- Add Tauri commands `runs_queue_update`, `runs_queue_reorder`, `runs_queue_steer` in `src-tauri/src/ipc/mod.rs` and register them in `src-tauri/src/lib.rs`.
- Export `runsQueueUpdate(threadId, queueId, text)`, `runsQueueReorder(threadId, queueIds)`, and `runsQueueSteer(threadId, queueId)` (all `Promise<void>`) in `src/lib/ipc.ts`.

### Task 3: Composer Queue Row UI (`src/components/chat/Composer.tsx`)

- Make each queue row draggable via a drag handle (or row) with `aria-label="Reorder queued message"`; on `dragstart` / `dragover` / `drop`, call `runsQueueReorder(threadId, reorderedIds)`.
- Replace the Edit button icon with Lucide `Pencil` (`svg.lucide-pencil`) and keep `aria-label="Edit queued message"`.
- Clicking Edit enters inline edit mode on that row with a prefilled textbox plus `Save` and `Cancel` buttons (`Enter` saves, `Escape` cancels without cancelling the active run). Saving calls `runsQueueUpdate(threadId, item.id, newText)` and does NOT call `runsQueueRemove`.
- Add a Steer button (`aria-label="Steer queued message"`) calling `runsQueueSteer(threadId, item.id)` without calling `runsQueueRemove` or `runsDispatch`.

### Task 4: Verification

- `pnpm test tests/queue-actions.test.tsx tests/composer.test.tsx tests/composer-attachments.test.tsx`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib queue`
- `pnpm typecheck && pnpm lint && pnpm test`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
