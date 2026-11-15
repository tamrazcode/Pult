import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { permissionsRememberedClear, permissionsRememberedList } from "../lib/ipc";
import type { RememberedPermission } from "../lib/types";
import { useSettingsStore } from "../stores/settings";

export const Route = createFileRoute("/settings/general")({ component: GeneralSettings });

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-text-tertiary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function GeneralSettings() {
  const confirmDeleteThread = useSettingsStore((s) => s.confirmDeleteThread);
  const setConfirmDeleteThread = useSettingsStore((s) => s.setConfirmDeleteThread);
  const [permissions, setPermissions] = useState<RememberedPermission[]>([]);

  useEffect(() => {
    let alive = true;
    void permissionsRememberedList()
      .then((list) => {
        if (alive) setPermissions(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const revoke = (permission: RememberedPermission) => {
    void permissionsRememberedClear({
      workspace: permission.workspace,
      instanceId: permission.instanceId,
      toolKind: permission.toolKind,
    })
      .then(() =>
        setPermissions((list) =>
          list.filter(
            (candidate) =>
              !(
                candidate.workspace === permission.workspace &&
                candidate.instanceId === permission.instanceId &&
                candidate.toolKind === permission.toolKind
              ),
          ),
        ),
      )
      .catch(() => {});
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">General</h2>
      <p className="mt-1 text-sm text-text-tertiary">Everyday behaviour of the app.</p>
      <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
        <Toggle
          label="Confirm before deleting threads"
          description="Ask before a transcript and its worktree are removed."
          checked={confirmDeleteThread}
          onChange={setConfirmDeleteThread}
        />
      </div>

      <h3 className="mt-8 text-sm font-medium text-text-primary">Remembered permissions</h3>
      <p className="mt-1 text-xs text-text-tertiary">
        “Always allow” choices are scoped to one project and agent. Revoke them here.
      </p>
      {permissions.length === 0 ? (
        <p className="mt-3 text-xs text-text-tertiary">Nothing remembered yet.</p>
      ) : (
        <>
          <ul className="mt-3 divide-y divide-border-subtle border-y border-border-subtle">
            {permissions.map((permission) => (
              <li
                key={`${permission.workspace}|${permission.instanceId}|${permission.toolKind}`}
                className="flex items-center gap-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-text-primary">
                    {permission.toolKind} · {permission.instanceId}
                  </p>
                  <p className="truncate font-mono text-xs text-text-tertiary">
                    {permission.workspace}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(permission)}
                  className="shrink-0 rounded-(--radius-sm) border border-border-subtle px-2 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-danger"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              void permissionsRememberedClear()
                .then(() => setPermissions([]))
                .catch(() => {});
            }}
            className="mt-2 text-xs text-text-tertiary transition hover:text-danger"
          >
            Clear all
          </button>
        </>
      )}
    </div>
  );
}
