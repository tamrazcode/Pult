import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, GitBranch, Globe2, SquareTerminal } from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";
import { Button } from "../components/ui/button";
import { PultLogo } from "../components/ui/PultLogo";
import { ConnectRow, refreshDetected } from "../components/settings/AgentConnect";
import { ProfileCard } from "../components/profile/ProfileCard";
import { isTauri } from "../lib/tauri";
import { settingsSet } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { isValidHandle, sanitizeProfile, useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import type { DetectedAgent } from "../lib/types";

export const Route = createFileRoute("/welcome")({ component: WelcomePage });

const NODE_POSITIONS = [
  { x: 52, y: 16 },
  { x: 82, y: 34 },
  { x: 86, y: 66 },
  { x: 62, y: 86 },
  { x: 30, y: 82 },
  { x: 14, y: 54 },
  { x: 24, y: 24 },
];

function agentInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}

export function WelcomePage() {
  const t = useT();
  const router = useRouter();
  const profile = useSettingsStore((s) => s.profile);
  const instances = useUiStore((s) => s.instances);
  const setProfile = useSettingsStore((s) => s.setProfile);
  const [step, setStep] = useState(0);
  const [detected, setDetected] = useState<DetectedAgent[]>([]);
  const [finishing, setFinishing] = useState(false);
  const [nickname, setNickname] = useState(profile?.nickname ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [hue, setHue] = useState(profile?.avatar.hue ?? 215);
  const [avatar, setAvatar] = useState(profile?.avatar.value ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isTauri()) void refreshDetected(setDetected);
  }, []);

  const draft = useMemo(
    () => ({
      version: 1 as const,
      nickname: nickname.trim() || t("profile.unnamed"),
      handle: handle.replace(/^@/, "").toLowerCase() || "you",
      avatar: {
        kind: avatar ? ("image" as const) : ("initials" as const),
        value: avatar,
        hue,
      },
    }),
    [avatar, handle, hue, nickname, t],
  );

  const finish = () => {
    if (finishing) return;
    const candidate = sanitizeProfile({
      ...draft,
      nickname: nickname.trim(),
      handle: handle.replace(/^@/, "").toLowerCase(),
    });
    if (!nickname.trim()) {
      setError(t("profile.invalidNickname"));
      return;
    }
    if (!isValidHandle(handle.replace(/^@/, "").toLowerCase()) || !candidate) {
      setError(t("profile.invalidHandle"));
      return;
    }
    setProfile(candidate);
    setFinishing(true);
    void settingsSet("onboarding_completed", true)
      .catch(() => {})
      .finally(() => {
        window.setTimeout(() => void router.navigate({ to: "/chat", replace: true }), 520);
      });
  };

  const nodes = detected.slice(0, NODE_POSITIONS.length);

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${finishing ? "onboarding-exit" : ""}`}>
      <RouteHeader title={t("onboarding.heading")} />
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className="pointer-events-none absolute inset-0 opacity-60">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,var(--accent)/10,transparent_55%)]" />
        </div>
        <div className="relative w-full max-w-3xl">
          <div className="mb-6 flex items-center justify-between text-xs text-text-tertiary">
            <span className="tnum">{String(step + 1).padStart(2, "0")} / 04</span>
            <button
              type="button"
              onClick={() => void router.navigate({ to: "/chat" })}
              className="rounded-(--radius-sm) px-2 py-1 transition hover:bg-hover hover:text-text-secondary"
            >
              {t("onboarding.skip")}
            </button>
          </div>

          {step === 0 && (
            <div className="space-y-8 text-center">
              <div>
                <h1 className="text-3xl font-medium tracking-tight text-text-primary">
                  {t("onboarding.step1.title")}
                </h1>
                <p className="mx-auto mt-2 max-w-md text-sm text-text-secondary">
                  {t("onboarding.step1.body")}
                </p>
              </div>

              <div className="relative mx-auto h-[320px] w-full max-w-lg">
                <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
                  {nodes.map((_, index) => {
                    const node = NODE_POSITIONS[index];
                    return (
                      <line
                        key={index}
                        x1="50"
                        y1="50"
                        x2={node.x}
                        y2={node.y}
                        stroke="var(--accent)"
                        strokeWidth="0.35"
                        strokeDasharray="80"
                        className="onboarding-line"
                        style={{ animationDelay: `${index * 140}ms` }}
                      />
                    );
                  })}
                </svg>
                <div className="absolute top-1/2 left-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[26px] border border-border-strong bg-surface-raised shadow-(--shadow-composer)">
                  <PultLogo className="h-10 w-10 text-text-primary" />
                </div>
                {nodes.map((agent, index) => {
                  const node = NODE_POSITIONS[index];
                  return (
                    <div
                      key={agent.id}
                      className="onboarding-node absolute flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2.5 py-1.5 text-xs text-text-secondary shadow-(--shadow-composer)"
                      style={{
                        left: `${node.x}%`,
                        top: `${node.y}%`,
                        transform: "translate(-50%, -50%)",
                        animationDelay: `${300 + index * 120}ms`,
                      }}
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-active text-xs font-semibold text-text-secondary">
                        {agentInitials(agent.displayName)}
                      </span>
                      <span className="max-w-[110px] truncate">{agent.displayName}</span>
                    </div>
                  );
                })}
              </div>

              <Button variant="primary" size="md" onClick={() => setStep(1)}>
                {t("onboarding.getStarted")} <ArrowRight size={14} />
              </Button>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs tracking-wider text-text-tertiary uppercase">
                    {t("onboarding.step2.eyebrow")}
                  </p>
                  <h1 className="mt-1 text-2xl font-medium text-text-primary">
                    {t("onboarding.step2.title")}
                  </h1>
                  <p className="mt-1 text-sm text-text-secondary">{t("onboarding.step2.body")}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                    <ArrowLeft size={13} /> {t("onboarding.back")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setStep(2)}>
                    {t("onboarding.continue")} <ArrowRight size={13} />
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {detected.length === 0 && (
                  <p className="rounded-(--radius-md) border border-border-subtle bg-surface p-4 text-sm text-text-tertiary">
                    {t("onboarding.step2.none")}
                  </p>
                )}
                {detected.map((agent) => (
                  <div
                    key={agent.id}
                    className="rounded-(--radius-md) border border-border-subtle bg-surface p-3"
                  >
                    <ConnectRow
                      agent={agent}
                      alreadyAdded={instances.some(
                        (instance) =>
                          instance.id === agent.suggestedInstanceId ||
                          instance.command === agent.command,
                      )}
                      onAdded={() => void refreshDetected(setDetected)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs tracking-wider text-text-tertiary uppercase">
                    {t("onboarding.step3.eyebrow")}
                  </p>
                  <h1 className="mt-1 text-2xl font-medium text-text-primary">
                    {t("onboarding.step3.title")}
                  </h1>
                  <p className="mt-1 text-sm text-text-secondary">{t("onboarding.step3.body")}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                    <ArrowLeft size={13} /> {t("onboarding.back")}
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setStep(3)}>
                    {t("onboarding.continue")} <ArrowRight size={13} />
                  </Button>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  {
                    icon: GitBranch,
                    title: "onboarding.tour.git",
                    body: "onboarding.tour.gitBody",
                  },
                  {
                    icon: Globe2,
                    title: "onboarding.tour.browser",
                    body: "onboarding.tour.browserBody",
                  },
                  {
                    icon: SquareTerminal,
                    title: "onboarding.tour.terminal",
                    body: "onboarding.tour.terminalBody",
                  },
                ].map((card) => (
                  <div
                    key={card.title}
                    className="rounded-(--radius-md) border border-border-subtle bg-surface p-4"
                  >
                    <card.icon size={18} className="text-accent" />
                    <p className="mt-3 text-sm font-medium text-text-primary">{t(card.title)}</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                      {t(card.body)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <div className="text-center">
                <p className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("onboarding.step4.eyebrow")}
                </p>
                <h1 className="mt-1 text-2xl font-medium text-text-primary">
                  {t("onboarding.step4.title")}
                </h1>
                <p className="mt-1 text-sm text-text-secondary">{t("onboarding.step4.body")}</p>
              </div>
              <div className="grid gap-5 sm:grid-cols-[1fr_300px]">
                <div className="space-y-3">
                  <input
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    placeholder={t("profile.nicknamePlaceholder")}
                    aria-label={t("profile.nickname")}
                    maxLength={40}
                    className="h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-surface px-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
                  />
                  <div className="flex h-9 items-center rounded-(--radius-sm) border border-border-subtle bg-surface focus-within:border-border-strong">
                    <span className="pl-2.5 text-sm text-text-tertiary">@</span>
                    <input
                      value={handle}
                      onChange={(event) => setHandle(event.target.value.toLowerCase())}
                      placeholder="you"
                      aria-label={t("profile.handle")}
                      maxLength={24}
                      className="h-full min-w-0 flex-1 bg-transparent px-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {[215, 262, 330, 12, 38, 152, 188].map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-label={`${t("profile.accent")} ${value}`}
                        aria-pressed={hue === value}
                        onClick={() => setHue(value)}
                        className={`h-5 w-5 rounded-full border-2 ${
                          hue === value ? "border-text-primary" : "border-transparent"
                        }`}
                        style={{ background: `hsl(${value} 72% 56%)` }}
                      />
                    ))}
                    <label className="ml-1 cursor-pointer text-xs text-text-tertiary transition hover:text-text-secondary">
                      {t("profile.uploadAvatar")}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file || file.size > 1_500_000) return;
                          const reader = new FileReader();
                          reader.onload = () =>
                            typeof reader.result === "string" && setAvatar(reader.result);
                          reader.readAsDataURL(file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  </div>
                  {error && (
                    <p role="alert" className="text-xs text-danger">
                      {error}
                    </p>
                  )}
                </div>
                <div className="space-y-3">
                  <ProfileCard profile={draft} />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                      <ArrowLeft size={13} /> {t("onboarding.back")}
                    </Button>
                    <Button variant="primary" size="sm" onClick={finish}>
                      <Check size={13} /> {t("onboarding.finish")}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
