import { describe, expect, it } from "vitest";
import { resolveBreadcrumbs } from "../src/lib/breadcrumbs";
import type { Project, Thread } from "../src/lib/types";

const alpha: Project = {
  id: "alpha",
  name: "Alpha",
  rootPath: "C:\\work\\alpha",
  color: "#346bf1",
  worktreeStrategy: "root",
  pinned: false,
  createdAt: 0,
};

const thread: Thread = {
  id: "th-1",
  projectId: null,
  title: "Fix the parser",
  status: "draft",
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
};

const projectThread: Thread = {
  id: "th-2",
  projectId: "alpha",
  title: "Wire project header",
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
    expect(resolveBreadcrumbs("/usage", []).map((c) => c.label)).toEqual(["pult", "Usage"]);
  });

  it("falls back to a neutral label for an unknown or missing thread", () => {
    expect(resolveBreadcrumbs("/thread/gone", []).at(-1)?.label).toBe("Thread");
    expect(resolveBreadcrumbs("/settings/unknown", []).at(-1)?.label).toBe("Settings");
  });

  it("includes the project name for a thread with projectId and omits it without", () => {
    expect(
      resolveBreadcrumbs("/thread/th-2", [thread, projectThread], [alpha]).map((c) => c.label),
    ).toEqual(["pult", "Alpha", "Wire project header"]);

    expect(
      resolveBreadcrumbs("/thread/th-1", [thread, projectThread], [alpha]).map((c) => c.label),
    ).toEqual(["pult", "Fix the parser"]);
  });

  it("includes the selected project name on /chat and omits it when unselected", () => {
    expect(resolveBreadcrumbs("/chat", [thread], [alpha], "alpha").map((c) => c.label)).toEqual([
      "pult",
      "Alpha",
      "New thread",
    ]);

    expect(resolveBreadcrumbs("/chat", [thread], [alpha], null).map((c) => c.label)).toEqual([
      "pult",
      "New thread",
    ]);
  });
});
