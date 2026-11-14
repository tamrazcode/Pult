import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  bindingFor,
  eventToBinding,
  formatBinding,
  matchesBinding,
} from "../src/lib/hotkeys";
import { buildCommands } from "../src/lib/commands";

const key = (over: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }) as KeyboardEvent;

describe("hotkeys (§6.7)", () => {
  it("eventToBinding normalizes modifiers and single keys", () => {
    expect(eventToBinding(key({ key: "k", ctrlKey: true }))).toBe("Mod+k");
    expect(eventToBinding(key({ key: "d", ctrlKey: true, altKey: true }))).toBe("Mod+Alt+d");
    expect(eventToBinding(key({ key: "K", ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+k");
    expect(eventToBinding(key({ key: "Escape" }))).toBe("Escape");
    expect(eventToBinding(key({ key: "Enter", metaKey: true }))).toBe("Mod+Enter");
  });

  it("matchesBinding treats Mod as meta or ctrl and checks the others exactly", () => {
    expect(matchesBinding(key({ key: "k", ctrlKey: true }), "Mod+k")).toBe(true);
    expect(matchesBinding(key({ key: "k", metaKey: true }), "Mod+k")).toBe(true);
    expect(matchesBinding(key({ key: "k" }), "Mod+k")).toBe(false);
    expect(matchesBinding(key({ key: "d", ctrlKey: true, altKey: true }), "Mod+Alt+d")).toBe(true);
    expect(matchesBinding(key({ key: "d", ctrlKey: true }), "Mod+Alt+d")).toBe(false);
    expect(matchesBinding(key({ key: "Escape" }), "Escape")).toBe(true);
    expect(matchesBinding(key({ key: "Escape", shiftKey: true }), "Escape")).toBe(false);
  });

  it("bindingFor prefers overrides and falls back to the registry defaults", () => {
    expect(bindingFor("palette.open", {})).toBe("Mod+K");
    expect(bindingFor("chat.new", { "chat.new": "Mod+Shift+N" })).toBe("Mod+Shift+N");
    expect(bindingFor("unknown.command", {})).toBeUndefined();
    // defaults derive from the command registry — the two sources agree
    for (const [id, binding] of Object.entries(DEFAULT_BINDINGS)) {
      if (id === "palette.open") continue;
      expect(bindingFor(id, {}), id).toBe(binding);
    }
  });

  it("formatBinding renders the platform hint", () => {
    const mod = formatBinding("Mod+k").endsWith("k") ? formatBinding("Mod+k").slice(0, -1) : "";
    expect(["⌘", "Ctrl"]).toContain(mod);
    expect(formatBinding("Mod+Alt+d")).toMatch(/Alt/);
  });
});

describe("command palette registry", () => {
  it("lists static commands plus one per thread", () => {
    const ctx = { navigate: () => {} };
    const commands = buildCommands(ctx, [
      { id: "t1", title: "First", status: "settled" },
      { id: "t2", title: "", status: "working" },
    ]);
    expect(commands.some((c) => c.id === "chat.new")).toBe(true);
    expect(commands.filter((c) => c.id.startsWith("thread.open."))).toHaveLength(2);
    const untitled = commands.find((c) => c.id === "thread.open.t2");
    expect(untitled?.title).toBe("Untitled thread");
  });

  it("navigation commands run through the ctx", () => {
    const paths: string[] = [];
    const commands = buildCommands({ navigate: (p) => paths.push(p) }, []);
    commands.find((c) => c.id === "settings.appearance")!.run({ navigate: (p) => paths.push(p) });
    expect(paths).toEqual(["/settings/appearance"]);
  });
});
