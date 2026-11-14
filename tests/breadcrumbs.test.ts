import { describe, expect, it } from "vitest";
import { resolveBreadcrumbs } from "../src/lib/breadcrumbs";
import type { Thread } from "../src/lib/types";

const thread: Thread = {
  id: "th-1",
  projectId: null,
  title: "Fix the parser",
  status: "draft",
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
};

describe("resolveBreadcrumbs", () => {
  it("maps every route without the static pult / chat", () => {
    expect(resolveBreadcrumbs("/chat", [thread]).map((c) => c.label)).toEqual([
      "pult",
      "New thread",
    ]);
    expect(resolveBreadcrumbs("/thread/th-1", [thread]).map((c) => c.label)).toEqual([
      "pult",
      "Fix the parser",
    ]);
    expect(resolveBreadcrumbs("/pull-requests", []).map((c) => c.label)).toEqual([
      "pult",
      "Pull requests",
    ]);
    expect(resolveBreadcrumbs("/settings/keybindings", []).map((c) => c.label)).toEqual([
      "pult",
      "Settings",
      "Keybindings",
    ]);
    expect(resolveBreadcrumbs("/welcome", []).map((c) => c.label)).toEqual(["pult", "Setup"]);
  });

  it("falls back to a neutral label for an unknown or missing thread", () => {
    expect(resolveBreadcrumbs("/thread/gone", []).at(-1)?.label).toBe("Thread");
    expect(resolveBreadcrumbs("/settings/unknown", []).at(-1)?.label).toBe("Settings");
  });
});
