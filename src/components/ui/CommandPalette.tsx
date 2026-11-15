import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useThreadsStore } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { buildCommands, type Command } from "../../lib/commands";
import { bindingFor, formatBinding, matchesBinding } from "../../lib/hotkeys";
import { useSettingsStore } from "../../stores/settings";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * ⌘K command palette (§6.7): threads, navigation, actions, appearance — the
 * same command registry that hotkeys dispatch through. Keyboard-complete:
 * ↑↓ move, Enter runs, Esc closes, type-to-filter.
 */
export function CommandPalette({ open, onClose }: Props) {
  const router = useRouter();
  const threads = useThreadsStore((s) => s.threads);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const navigate = useMemo(() => (path: string) => void router.navigate({ to: path }), [router]);

  const commands = useMemo(() => buildCommands({ navigate }, threads), [navigate, threads]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const result = q
      ? commands.filter((c) =>
          `${c.title} ${c.keywords ?? ""} ${c.section}`.toLowerCase().includes(q),
        )
      : commands;
    const order: Command["section"][] = [
      "Actions",
      "Navigate",
      "Threads",
      "Appearance",
      "Settings",
    ];
    return [...result].sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setCursor(0);
      // focus after the modal mounts
      requestAnimationFrame(() => inputRef.current?.focus());
      return () => previousFocusRef.current?.focus();
    }
  }, [open]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  if (!open) return null;

  const runCommand = (cmd: Command) => {
    onClose();
    cmd.run({ navigate });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      const root = dialogRef.current;
      if (!root) return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      return;
    }
    if (e.key === "Enter" && filtered[cursor]) {
      e.preventDefault();
      runCommand(filtered[cursor]);
    }
  };

  let lastSection = "";

  return (
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="absolute top-[15%] left-1/2 w-[560px] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-(--radius-lg) border border-border-strong bg-surface-raised shadow-(--shadow-composer)"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3.5 py-2.5">
          <Search size={14} className="text-text-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, threads, settings…"
            aria-label="Search commands"
            className="w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary"
          />
          <kbd className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-xs text-text-tertiary">
            {formatBinding(bindingFor("palette.open", keybindings) ?? "Mod+K")}
          </kbd>
        </div>
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1" role="listbox">
          {filtered.length === 0 && (
            <p className="px-3.5 py-6 text-center text-sm text-text-tertiary">
              Nothing matches “{query}”.
            </p>
          )}
          {filtered.map((cmd, idx) => {
            const header =
              cmd.section !== lastSection ? (
                <p
                  key={`sec-${cmd.section}`}
                  className="px-3.5 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary uppercase"
                >
                  {cmd.section}
                </p>
              ) : null;
            lastSection = cmd.section;
            return (
              <div key={cmd.id}>
                {header}
                <button
                  data-idx={idx}
                  role="option"
                  aria-selected={idx === cursor}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => runCommand(cmd)}
                  className={`flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-sm transition ${
                    idx === cursor ? "bg-hover text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{cmd.title}</span>
                  {bindingFor(cmd.id, keybindings) && (
                    <kbd className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-xs text-text-tertiary">
                      {formatBinding(bindingFor(cmd.id, keybindings)!)}
                    </kbd>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Global hotkeys (§6.7): palette toggle plus the bound static commands.
 * Mounted once in the root layout; composer-scoped keys (send, A/S/D) stay
 * with the composer.
 */
export function useGlobalHotkeys(openPalette: () => void): void {
  const router = useRouter();
  const keybindings = useSettingsStore((s) => s.keybindings);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const navigate = (path: string) => void router.navigate({ to: path });
      // bindingFor falls back to DEFAULT_BINDINGS — no per-call defaults here
      const b = (id: string) => bindingFor(id, keybindings);

      if (b("palette.open") && matchesBinding(e, b("palette.open")!)) {
        e.preventDefault();
        openPalette();
        return;
      }
      // typing guard: only the palette binding works inside text fields
      if (typing) return;
      if (b("chat.new") && matchesBinding(e, b("chat.new")!)) {
        e.preventDefault();
        useProjectsStore.getState().selectProject(null);
        navigate("/chat");
        return;
      }
      if (b("view.sidebar") && matchesBinding(e, b("view.sidebar")!)) {
        e.preventDefault();
        useUiStore.getState().toggleSidebar();
        return;
      }
      if (b("view.panel.diff") && matchesBinding(e, b("view.panel.diff")!)) {
        e.preventDefault();
        useUiStore.getState().setRightPanelTab("diff");
        return;
      }
      if (b("view.panel.terminal") && matchesBinding(e, b("view.panel.terminal")!)) {
        e.preventDefault();
        useUiStore.getState().setRightPanelTab("terminal");
        return;
      }
      if (b("view.panel.browser") && matchesBinding(e, b("view.panel.browser")!)) {
        e.preventDefault();
        useUiStore.getState().setRightPanelTab("browser");
        return;
      }
      if (b("view.panel.files") && matchesBinding(e, b("view.panel.files")!)) {
        e.preventDefault();
        useUiStore.getState().setRightPanelTab("files");
        return;
      }
      if (b("settings.open") && matchesBinding(e, b("settings.open")!)) {
        e.preventDefault();
        navigate("/settings/appearance");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router, keybindings, openPalette]);
}
