import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalsStore } from "../src/stores/terminals";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function push(terminalId: string, text: string, slice?: [number, number]) {
  const bytes = new TextEncoder().encode(text);
  const chunk = slice ? bytes.slice(slice[0], slice[1]) : bytes;
  useTerminalsStore.getState().pushChunk({ terminalId, threadId: "th", data: b64(chunk) });
}

describe("terminals store", () => {
  beforeEach(() => {
    useTerminalsStore.setState({ byThread: {}, activeByThread: {}, backfill: {} });
  });

  it("decodes a multibyte codepoint split across chunks", () => {
    push("t1", "привет", [0, 3]);
    expect(useTerminalsStore.getState().backfill["t1"]).toEqual(["п"]);
    push("t1", "привет", [3, 12]);
    expect(useTerminalsStore.getState().backfill["t1"]).toEqual(["п", "ривет"]);
  });

  it("replaces the backfill array instead of mutating state", () => {
    push("t2", "a");
    const before = useTerminalsStore.getState().backfill["t2"];
    push("t2", "b");
    const after = useTerminalsStore.getState().backfill["t2"];
    expect(before).toEqual(["a"]);
    expect(after).toEqual(["a", "b"]);
    expect(after).not.toBe(before);
  });

  it("drops buffered output when a terminal is removed", () => {
    useTerminalsStore.getState().addTerminal("th", {
      terminalId: "t3",
      title: "shell",
      exit: null,
    });
    push("t3", "leftover");
    useTerminalsStore.getState().removeTerminal("th", "t3");
    expect(useTerminalsStore.getState().backfill["t3"]).toBeUndefined();
    expect(useTerminalsStore.getState().byThread["th"]).toEqual([]);
    expect(useTerminalsStore.getState().activeByThread["th"]).toBeNull();
  });

  it("clearThread drops the thread's terminals, backfill and live subscribers only", () => {
    useTerminalsStore.getState().addTerminal("gone", {
      terminalId: "tg",
      title: "shell",
      exit: null,
    });
    useTerminalsStore.getState().addTerminal("kept", {
      terminalId: "tk",
      title: "shell",
      exit: null,
    });
    push("tg", "leftover");
    push("tk", "keep");
    const listener = vi.fn();
    useTerminalsStore.getState().subscribeData("tg", listener);

    useTerminalsStore.getState().clearThread("gone");

    expect(useTerminalsStore.getState().byThread["gone"]).toBeUndefined();
    expect(useTerminalsStore.getState().activeByThread["gone"]).toBeUndefined();
    expect(useTerminalsStore.getState().backfill["tg"]).toBeUndefined();
    expect(useTerminalsStore.getState().byThread["kept"]).toHaveLength(1);
    expect(useTerminalsStore.getState().backfill["tk"]).toEqual(["keep"]);

    // The old subscriber is gone: output now lands in backfill instead.
    push("tg", "after delete");
    expect(listener).not.toHaveBeenCalled();
    expect(useTerminalsStore.getState().backfill["tg"]).toEqual(["after delete"]);
  });
});
