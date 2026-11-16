import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FolderOpen, Puzzle } from "lucide-react";
import { openInEditor, pluginsList, pluginsSetEnabled, type PluginInfo } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/settings/plugins")({ component: PluginsSettings });

function PluginsSettings() {
  const t = useT();
  const [dir, setDir] = useState("");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!isTauri()) return;
    void pluginsList()
      .then((list) => {
        setDir(list.dir);
        setPlugins(list.plugins);
      })
      .catch(() => setPlugins([]));
  };

  useEffect(load, []);

  const toggle = (plugin: PluginInfo) => {
    const enabled = !plugin.enabled;
    setError(null);
    setPlugins((items) =>
      items.map((item) => (item.id === plugin.id ? { ...item, enabled } : item)),
    );
    void pluginsSetEnabled(plugin.id, enabled).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      load();
    });
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-text-primary">{t("plugins.title")}</h2>
          <p className="mt-1 text-sm text-text-tertiary">{t("plugins.subtitle")}</p>
        </div>
        <button
          type="button"
          disabled={!dir}
          onClick={() => void openInEditor(dir, "explorer").catch(() => {})}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
        >
          <FolderOpen size={13} /> {t("plugins.openFolder")}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-5 space-y-2">
        {plugins.length === 0 && (
          <div className="rounded-(--radius-md) border border-border-subtle bg-surface p-5">
            <Puzzle size={18} className="text-text-tertiary" />
            <p className="mt-2 text-sm text-text-secondary">{t("plugins.empty")}</p>
            <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
              {t("plugins.emptyHint")}
            </p>
          </div>
        )}
        {plugins.map((plugin) => (
          <div
            key={plugin.id}
            className="flex items-start gap-3 rounded-(--radius-md) border border-border-subtle bg-surface p-3"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-sm) bg-active text-text-secondary">
              <Puzzle size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <p className="truncate text-sm font-medium text-text-primary">{plugin.name}</p>
                <span className="shrink-0 text-xs text-text-tertiary">v{plugin.version}</span>
                {plugin.author && (
                  <span className="truncate text-xs text-text-tertiary">· {plugin.author}</span>
                )}
              </div>
              {plugin.description && (
                <p className="mt-0.5 text-xs text-text-secondary">{plugin.description}</p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {plugin.commands.map((command) => (
                  <span
                    key={`command-${command}`}
                    className="rounded-(--radius-sm) bg-active px-1.5 py-0.5 font-mono text-xs text-text-tertiary"
                  >
                    /{command}
                  </span>
                ))}
                {plugin.slots.map((slot) => (
                  <span
                    key={`slot-${slot}`}
                    className="rounded-(--radius-sm) border border-border-subtle px-1.5 py-0.5 text-xs text-text-tertiary"
                  >
                    {slot}
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={plugin.enabled}
              aria-label={`${t("plugins.enabled")}: ${plugin.name}`}
              onClick={() => toggle(plugin)}
              className={`relative mt-1 h-5 w-9 shrink-0 rounded-full border transition ${
                plugin.enabled ? "border-accent bg-accent" : "border-border-strong bg-surface"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                  plugin.enabled ? "left-[18px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-text-tertiary">
        {t("plugins.dir")} <span className="font-mono">{dir || "~/.pult/plugins"}</span>
      </p>
    </div>
  );
}
