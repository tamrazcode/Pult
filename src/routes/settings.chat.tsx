import { createFileRoute } from "@tanstack/react-router";
import { useSettingsStore } from "../stores/settings";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/settings/chat")({ component: ChatSettings });

function ChatSettings() {
  const t = useT();
  const sendKey = useSettingsStore((s) => s.sendKey);
  const setSendKey = useSettingsStore((s) => s.setSendKey);
  const followStreaming = useSettingsStore((s) => s.followStreaming);
  const setFollowStreaming = useSettingsStore((s) => s.setFollowStreaming);
  const showTimestamps = useSettingsStore((s) => s.showTimestamps);
  const setShowTimestamps = useSettingsStore((s) => s.setShowTimestamps);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const notificationSound = useSettingsStore((s) => s.notificationSound);
  const setNotificationSound = useSettingsStore((s) => s.setNotificationSound);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">{t("settings.chat.title")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">{t("settings.chat.subtitle")}</p>

      <h3 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        {t("settings.chat.sendWith")}
      </h3>
      <div role="radiogroup" aria-label={t("settings.chat.sendWith")} className="mt-2 flex gap-1.5">
        {(
          [
            ["enter", "Enter"],
            ["mod-enter", "Mod+Enter"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={sendKey === value}
            onClick={() => setSendKey(value)}
            className={`rounded-(--radius-sm) border px-3 py-1 text-xs transition ${
              sendKey === value
                ? "border-accent/50 bg-accent/10 text-text-primary"
                : "border-border-subtle bg-surface text-text-tertiary hover:bg-hover"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-tertiary">{t("settings.chat.sendWithHint")}</p>

      <div className="mt-6 divide-y divide-border-subtle border-y border-border-subtle">
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">{t("settings.chat.follow")}</p>
            <p className="mt-0.5 text-xs text-text-tertiary">{t("settings.chat.followDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={followStreaming}
            aria-label={t("settings.chat.follow")}
            onClick={() => setFollowStreaming(!followStreaming)}
            className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
              followStreaming ? "border-accent bg-accent" : "border-border-strong bg-surface"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                followStreaming ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">{t("settings.chat.timestamps")}</p>
            <p className="mt-0.5 text-xs text-text-tertiary">{t("settings.chat.timestampsDesc")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showTimestamps}
            aria-label={t("settings.chat.timestamps")}
            onClick={() => setShowTimestamps(!showTimestamps)}
            className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
              showTimestamps ? "border-accent bg-accent" : "border-border-strong bg-surface"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                showTimestamps ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">{t("settings.chat.notifications")}</p>
            <p className="mt-0.5 text-xs text-text-tertiary">
              {t("settings.chat.notificationsDesc")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notificationsEnabled}
            aria-label={t("settings.chat.notifications")}
            onClick={() => setNotificationsEnabled(!notificationsEnabled)}
            className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
              notificationsEnabled ? "border-accent bg-accent" : "border-border-strong bg-surface"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                notificationsEnabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">{t("settings.chat.notificationSound")}</p>
            <p className="mt-0.5 text-xs text-text-tertiary">
              {t("settings.chat.notificationSoundDesc")}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={notificationSound}
            aria-label={t("settings.chat.notificationSound")}
            onClick={() => setNotificationSound(!notificationSound)}
            className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
              notificationSound ? "border-accent bg-accent" : "border-border-strong bg-surface"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                notificationSound ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
