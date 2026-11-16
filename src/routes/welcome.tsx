import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, GitBranch, Globe2, SquareTerminal } from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";
import { Button } from "../components/ui/button";
import { PultLogo } from "../components/ui/PultLogo";
import { ProviderLogo, providerIdentity } from "../components/chat/ProviderLogo";
import { ConnectRow, refreshDetected } from "../components/settings/AgentConnect";
import { ProfileCard } from "../components/profile/ProfileCard";
import { isTauri } from "../lib/tauri";
import { settingsSet } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { isValidHandle, sanitizeProfile, useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import type { DetectedAgent } from "../lib/types";

export const Route = createFileRoute("/welcome")({ component: WelcomePage });

function shortName(agent: DetectedAgent): string {
  return agent.displayName.replace(/\s+CLI$/i, "");
}

/** Smart scattered layout: 1 left, 2 opposite, 3+ on an ellipse. */
function providerPosition(index: number, count: number): { left: string; top: string } {
  if (count === 1) return { left: "24%", top: "50%" };
  if (count === 2) {
    return index === 0 ? { left: "24%", top: "50%" } : { left: "76%", top: "50%" };
  }
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
  return {
    left: `${50 + 30 * Math.cos(angle)}%`,
    top: `${50 + 32 * Math.sin(angle)}%`,
  };
}

function StepHeader({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-xl text-center">
      <h1 className="text-3xl font-medium tracking-tight text-text-primary">{title}</h1>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-text-secondary">{body}</p>
    </div>
  );
}

function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex items-center justify-center gap-3 pt-6">{children}</div>;
}

export function WelcomePage() {
  const t = useT();
  const router = useRouter();
  const profile = useSettingsStore((s) => s.profile);
  const setProfile = useSettingsStore((s) => s.setProfile);
  const instances = useUiStore((s) => s.instances);
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title={t("onboarding.heading")} hidePanels />
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-8">
        <div className={`w-full max-w-2xl ${finishing ? "onboarding-exit" : ""}`}>
          {step === 0 && (
            <div className="flex min-h-[500px] flex-col items-center">
              <StepHeader title={t("onboarding.step1.title")} body={t("onboarding.step1.body")} />

              <div className="relative mt-6 h-[320px] w-full max-w-xl">
                <div className="absolute top-1/2 left-1/2 z-10 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[26px] border border-border-strong bg-surface-raised shadow-(--shadow-composer)">
                  <PultLogo className="h-10 w-10 text-text-primary" />
                </div>
                {detected.map((agent, index) => {
                  const position = providerPosition(index, detected.length);
                  return (
                    <div
                      key={agent.id}
                      className="absolute -translate-x-1/2 -translate-y-1/2"
                      style={{ left: position.left, top: position.top }}
                    >
                      <div
                        className="pult-float flex items-center gap-2 rounded-full border border-border-subtle bg-surface px-3 py-1.5 text-xs text-text-secondary shadow-(--shadow-composer)"
                        style={{ animationDelay: `${index * 0.85}s` }}
                      >
                        <ProviderLogo instance={providerIdentity(agent)} className="h-4 w-4" />
                        <span className="max-w-[120px] truncate">{shortName(agent)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <StepActions>
                <Button variant="primary" size="md" onClick={() => setStep(1)}>
                  {t("onboarding.getStarted")} <ArrowRight size={14} />
                </Button>
              </StepActions>
            </div>
          )}

          {step === 1 && (
            <div className="flex min-h-[500px] flex-col items-center">
              <StepHeader title={t("onboarding.step2.title")} body={t("onboarding.step2.body")} />

              <div className="mt-6 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
                {detected.length === 0 && (
                  <p className="col-span-full rounded-(--radius-md) border border-border-subtle bg-surface p-4 text-center text-sm text-text-tertiary">
                    {t("onboarding.step2.none")}
                  </p>
                )}
                {detected.map((agent) => (
                  <div key={agent.id} className="min-w-0">
                    <ConnectRow
                      agent={{ ...agent, displayName: shortName(agent) }}
                      minimal
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

              <StepActions>
                <Button variant="ghost" size="md" onClick={() => setStep(0)}>
                  <ArrowLeft size={14} /> {t("onboarding.back")}
                </Button>
                <Button variant="primary" size="md" onClick={() => setStep(2)}>
                  {t("onboarding.continue")} <ArrowRight size={14} />
                </Button>
              </StepActions>
            </div>
          )}

          {step === 2 && (
            <div className="flex min-h-[500px] flex-col items-center">
              <StepHeader title={t("onboarding.step3.title")} body={t("onboarding.step3.body")} />

              <div className="mt-6 grid w-full gap-3 sm:grid-cols-3">
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
                    className="rounded-(--radius-md) border border-border-subtle bg-surface p-4 text-left"
                  >
                    <card.icon size={18} className="text-accent" />
                    <p className="mt-3 text-sm font-medium text-text-primary">{t(card.title)}</p>
                    <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                      {t(card.body)}
                    </p>
                  </div>
                ))}
              </div>

              <StepActions>
                <Button variant="ghost" size="md" onClick={() => setStep(1)}>
                  <ArrowLeft size={14} /> {t("onboarding.back")}
                </Button>
                <Button variant="primary" size="md" onClick={() => setStep(3)}>
                  {t("onboarding.continue")} <ArrowRight size={14} />
                </Button>
              </StepActions>
            </div>
          )}

          {step === 3 && (
            <div className="flex min-h-[500px] flex-col items-center">
              <StepHeader title={t("onboarding.step4.title")} body={t("onboarding.step4.body")} />

              <div className="mt-6 grid w-full max-w-xl items-center gap-5 sm:grid-cols-[1fr_280px]">
                <div className="space-y-3 text-left">
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
                  <div className="flex flex-wrap items-center gap-2">
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
                <ProfileCard profile={draft} />
              </div>

              <StepActions>
                <Button variant="ghost" size="md" onClick={() => setStep(2)}>
                  <ArrowLeft size={14} /> {t("onboarding.back")}
                </Button>
                <Button variant="primary" size="md" onClick={finish}>
                  <Check size={14} /> {t("onboarding.finish")}
                </Button>
              </StepActions>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
