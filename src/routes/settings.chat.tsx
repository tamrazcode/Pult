import { createFileRoute } from "@tanstack/react-router";
import { useSettingsStore } from "../stores/settings";

export const Route = createFileRoute("/settings/chat")({ component: ChatSettings });

function ChatSettings() {
  const sendKey = useSettingsStore((s) => s.sendKey);
  const setSendKey = useSettingsStore((s) => s.setSendKey);
  const followStreaming = useSettingsStore((s) => s.followStreaming);
  const setFollowStreaming = useSettingsStore((s) => s.setFollowStreaming);
  const showTimestamps = useSettingsStore((s) => s.showTimestamps);
  const setShowTimestamps = useSettingsStore((s) => s.setShowTimestamps);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">Chat</h2>
      <p className="mt-1 text-sm text-text-tertiary">
        Composer behaviour and how the transcript streams.
      </p>

      <h3 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        Send message with
      </h3>
      <div role="radiogroup" aria-label="Send message with" className="mt-2 flex gap-1.5">
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
      <p className="mt-1 text-xs text-text-tertiary">
        The other combination always inserts a newline.
      </p>

      <div className="mt-6 divide-y divide-border-subtle border-y border-border-subtle">
        <div className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-text-primary">Follow streaming output</p>
            <p className="mt-0.5 text-xs text-text-tertiary">
              Keep the transcript pinned to the bottom while the agent writes.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={followStreaming}
            aria-label="Follow streaming output"
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
            <p className="text-sm text-text-primary">Show message timestamps</p>
            <p className="mt-0.5 text-xs text-text-tertiary">
              The send time appears beside the copy and branch actions on hover.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={showTimestamps}
            aria-label="Show message timestamps"
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
      </div>
    </div>
  );
}
