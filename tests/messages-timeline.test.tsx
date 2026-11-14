import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import { useRunsStore } from "../src/stores/runs";
import type { AppEvent, Run } from "../src/lib/types";

const run = (id: string, status: Run["status"], idx: number): Run => ({
  id,
  threadId: "th",
  idx,
  status,
  instanceId: "mock",
  startedAt: 0,
});

const deltaEvent = (runId: string, seq: number, text: string): AppEvent => ({
  id: `${runId}-${seq}`,
  runId,
  seq,
  ts: 0,
  kind: "agent_message_delta",
  payload: { delta: text },
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
  });
});

describe("MessagesTimeline", () => {
  it("renders every run's messages and keeps them when a new run starts", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "running", 1)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first prompt", images: [] },
            { type: "assistant", text: "first answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "second prompt", images: [] },
            { type: "assistant", text: "second answer", streaming: true },
          ],
          streaming: true,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("first prompt")).toBeInTheDocument();
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second prompt")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();

    act(() => {
      useRunsStore.getState().registerRun(run("r3", "running", 2));
      useRunsStore.getState().receiveRunEvent("r3", deltaEvent("r3", 0, "third answer"));
    });

    expect(screen.getByText("first prompt")).toBeInTheDocument();
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second prompt")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();
    expect(screen.getByText("third answer")).toBeInTheDocument();
  });

  it("windows the merged history across runs and expands it", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "finished", 1)] },
      viewsByRun: {
        r1: {
          items: Array.from({ length: 280 }, (_, i) => ({
            type: "user" as const,
            text: `old-${i}`,
            images: [],
          })),
          streaming: false,
        },
        r2: {
          items: Array.from({ length: 30 }, (_, i) => ({
            type: "user" as const,
            text: `new-${i}`,
            images: [],
          })),
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByText("old-0")).not.toBeInTheDocument();
    expect(screen.queryByText("old-9")).not.toBeInTheDocument();
    expect(screen.getByText("old-10")).toBeInTheDocument();
    expect(screen.getByText("new-29")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Earlier messages \(10 hidden\)/ }));
    expect(screen.getByText("old-0")).toBeInTheDocument();

    // Registering another run on the same thread must not reset the expanded window.
    act(() => {
      useRunsStore.getState().registerRun(run("r3", "running", 2));
      useRunsStore.getState().receiveRunEvent("r3", deltaEvent("r3", 0, "latest reply"));
    });
    expect(screen.getByText("old-0")).toBeInTheDocument();
    expect(screen.getByText("latest reply")).toBeInTheDocument();
  });
});
