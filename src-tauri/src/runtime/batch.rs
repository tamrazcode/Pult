//! Event batching and delta coalescing for streaming turns (Task 5).

use std::time::Duration;

use crate::events::{Event, EventKind};

pub const BATCH_WINDOW: Duration = Duration::from_millis(40);
pub const BATCH_MAX_ITEMS: usize = 32;

#[allow(dead_code)]
pub struct EventBatcher {
    run_id: String,
    next_seq: u64,
    pending: Vec<EventKind>,
}

impl EventBatcher {
    pub fn new(run_id: String, next_seq: u64) -> Self {
        Self {
            run_id,
            next_seq,
            pending: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Pushes an event kind into the batcher, coalescing adjacent text/thought
    /// deltas and flushing immediately on barrier events or `BATCH_MAX_ITEMS`.
    pub fn push(&mut self, kind: EventKind) -> Vec<Event> {
        let coalesces = matches!(
            (self.pending.last(), &kind),
            (
                Some(EventKind::AgentMessageDelta { .. }),
                EventKind::AgentMessageDelta { .. }
            ) | (
                Some(EventKind::AgentThoughtDelta { .. }),
                EventKind::AgentThoughtDelta { .. }
            )
        );
        if coalesces {
            match (self.pending.last_mut(), kind) {
                (
                    Some(EventKind::AgentMessageDelta { delta }),
                    EventKind::AgentMessageDelta { delta: next },
                ) => delta.push_str(&next),
                (
                    Some(EventKind::AgentThoughtDelta { delta, .. }),
                    EventKind::AgentThoughtDelta { delta: next, .. },
                ) => delta.push_str(&next),
                _ => unreachable!("coalescing was checked above"),
            }
            return Vec::new();
        }
        let mut flushed = Vec::new();
        if is_barrier(&kind) && !self.pending.is_empty() {
            flushed = self.flush_now();
        }
        self.pending.push(kind);
        if self.pending.len() >= BATCH_MAX_ITEMS {
            flushed.extend(self.flush_now());
        }
        flushed
    }

    /// Materializes all pending items into `Event`s with strictly monotonic
    /// contiguous `seq` numbers starting from `next_seq`.
    pub fn flush_now(&mut self) -> Vec<Event> {
        let mut events = Vec::with_capacity(self.pending.len());
        for kind in self.pending.drain(..) {
            events.push(Event::new(self.run_id.clone(), self.next_seq, kind));
            self.next_seq += 1;
        }
        events
    }
}

/// Events that must never be reordered behind buffered text.
fn is_barrier(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::ApprovalRequest { .. }
            | EventKind::ApprovalResponse { .. }
            | EventKind::ElicitationRequest { .. }
            | EventKind::ToolCall { .. }
            | EventKind::ToolCallUpdate { .. }
            | EventKind::Plan { .. }
            | EventKind::ConfigOptions { .. }
            | EventKind::FileChanged { .. }
            | EventKind::ModeChange { .. }
            | EventKind::Usage { .. }
            | EventKind::SubagentSpawned { .. }
            | EventKind::SubagentUpdated { .. }
            | EventKind::SubagentFinished { .. }
            | EventKind::RunFinished { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::PermissionOption;

    #[test]
    fn coalesces_adjacent_agent_message_deltas() {
        let mut batcher = EventBatcher::new("run-1".to_string(), 1);
        for chunk in ["Hel", "lo", ", ", "wor", "ld!"] {
            let flushed = batcher.push(EventKind::AgentMessageDelta {
                delta: chunk.to_string(),
            });
            assert!(flushed.is_empty(), "deltas should buffer until flush");
        }

        let events = batcher.flush_now();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].run_id, "run-1");
        assert_eq!(events[0].seq, 1);
        assert_eq!(
            events[0].kind,
            EventKind::AgentMessageDelta {
                delta: "Hello, world!".to_string(),
            }
        );
        assert!(batcher.is_empty());
    }

    #[test]
    fn approval_request_barrier_flushes_preceding_deltas_first() {
        let mut batcher = EventBatcher::new("run-2".to_string(), 1);
        assert!(batcher
            .push(EventKind::AgentMessageDelta {
                delta: "Need permission ".to_string(),
            })
            .is_empty());
        assert!(batcher
            .push(EventKind::AgentMessageDelta {
                delta: "to proceed.".to_string(),
            })
            .is_empty());

        let approval = EventKind::ApprovalRequest {
            request_id: "req-1".to_string(),
            tool_call_id: Some("tc-1".to_string()),
            title: "Run command?".to_string(),
            options: vec![PermissionOption {
                option_id: "allow".to_string(),
                name: "Allow".to_string(),
                kind: "allow_once".to_string(),
            }],
        };

        let pre_flushed = batcher.push(approval.clone());
        assert_eq!(
            pre_flushed.len(),
            1,
            "barrier must flush preceding delta first"
        );
        assert_eq!(pre_flushed[0].run_id, "run-2");
        assert_eq!(pre_flushed[0].seq, 1);
        assert_eq!(
            pre_flushed[0].kind,
            EventKind::AgentMessageDelta {
                delta: "Need permission to proceed.".to_string(),
            }
        );
        assert_eq!(batcher.len(), 1, "only approval should remain pending");

        let rest = batcher.flush_now();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].run_id, "run-2");
        assert_eq!(rest[0].seq, 2);
        assert_eq!(rest[0].kind, approval);
        assert!(batcher.is_empty());
    }

    #[test]
    fn flushes_at_max_items_with_monotonic_seq_and_drains_remainder() {
        let mut batcher = EventBatcher::new("run-3".to_string(), 1);
        let mut auto_flushed: Vec<Vec<Event>> = Vec::new();

        for i in 0..40 {
            let flushed = batcher.push(EventKind::Notice {
                level: "info".to_string(),
                message: format!("notice-{i}"),
            });
            if !flushed.is_empty() {
                auto_flushed.push(flushed);
            }
        }

        assert_eq!(auto_flushed.len(), 1);
        assert_eq!(auto_flushed[0].len(), BATCH_MAX_ITEMS);
        let first_seqs: Vec<u64> = auto_flushed[0].iter().map(|e| e.seq).collect();
        let expected_first: Vec<u64> = (1..=32).collect();
        assert_eq!(first_seqs, expected_first);

        assert_eq!(batcher.len(), 8);
        let remaining = batcher.flush_now();
        assert_eq!(remaining.len(), 8);
        let rest_seqs: Vec<u64> = remaining.iter().map(|e| e.seq).collect();
        let expected_rest: Vec<u64> = (33..=40).collect();
        assert_eq!(rest_seqs, expected_rest);
        assert!(batcher.is_empty());
    }
}
