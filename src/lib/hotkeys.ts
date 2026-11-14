import { STATIC_COMMANDS } from "./commands";

/**
 * Keyboard model (§6.7). Bindings are data: "Mod+K" where Mod = Cmd on macOS
 * and Ctrl elsewhere; "Alt", "Shift" compose. The palette and hotkey handler
 * share one registry; Settings → Keybindings rebinds by id.
 */

/** Platform-aware "Mod" label for hints. */
export const MOD_KEY = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

/** Palette-toggle binding lives here only (it has no static command entry). */
export const PALETTE_BINDING = "Mod+K";

/** Defaults derive from the command registry — one source, no drift. */
export const DEFAULT_BINDINGS: Record<string, string> = {
  "palette.open": PALETTE_BINDING,
  ...Object.fromEntries(
    STATIC_COMMANDS.filter((c) => c.defaultBinding).map((c) => [c.id, c.defaultBinding!]),
  ),
};

/** Effective binding for a command id: user override, else the default. */
export function bindingFor(id: string, overrides: Record<string, string>): string | undefined {
  return overrides[id] ?? DEFAULT_BINDINGS[id];
}

/** Reads the pressed event as a normalized binding string ("Mod+Shift+K"). */
export function eventToBinding(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string {
  const parts: string[] = [];
  const mod = e.metaKey || e.ctrlKey;
  if (mod) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  parts.push(key);
  return parts.join("+");
}

/** True when the event matches the binding (Mod matches meta or ctrl). */
export function matchesBinding(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  binding: string,
): boolean {
  const wanted = binding.split("+");
  const wantMod = wanted.includes("Mod");
  const wantAlt = wanted.includes("Alt");
  const wantShift = wanted.includes("Shift");
  const norm = (s: string) => (s.length === 1 ? s.toLowerCase() : s);
  const eventKey = norm(e.key);
  const key = norm(wanted[wanted.length - 1]);
  return (
    eventKey === key &&
    (wantMod ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey) &&
    wantAlt === e.altKey &&
    wantShift === e.shiftKey
  );
}

/** "Mod+K" → "⌘K"/"Ctrl+K" for display in menus and the palette. */
export function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((p) => (p === "Mod" ? MOD_KEY : p === "Alt" ? "Alt" : p === "Shift" ? "⇧" : p))
    .join("");
}
