import { useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ImagePlus, RotateCcw } from "lucide-react";
import { ProfileCard, ProfileAvatar } from "../components/profile/ProfileCard";
import { useT } from "../lib/i18n";
import {
  isValidHandle,
  sanitizeProfile,
  useSettingsStore,
  type LocalProfile,
} from "../stores/settings";

export const Route = createFileRoute("/settings/profile")({ component: ProfileSettings });

const HUES = [215, 262, 330, 12, 38, 152, 188];

function ProfileSettings() {
  const t = useT();
  const profile = useSettingsStore((s) => s.profile);
  const setProfile = useSettingsStore((s) => s.setProfile);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nickname, setNickname] = useState(profile?.nickname ?? "");
  const [handle, setHandle] = useState(profile?.handle ?? "");
  const [hue, setHue] = useState(profile?.avatar.hue ?? HUES[0]);
  const [avatar, setAvatar] = useState(profile?.avatar.value ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const draft: LocalProfile = {
    version: 1,
    nickname: nickname.trim() || t("profile.unnamed"),
    handle: handle.replace(/^@/, "").toLowerCase() || "you",
    avatar: { kind: avatar ? "image" : "initials", value: avatar, hue },
  };

  const pickAvatar = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_500_000) {
      setError(t("profile.avatarTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setAvatar(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const save = () => {
    const candidate = sanitizeProfile({
      ...draft,
      nickname: nickname.trim(),
      handle: handle.replace(/^@/, "").toLowerCase(),
    });
    if (!nickname.trim()) {
      setError(t("profile.invalidNickname"));
      return;
    }
    if (!isValidHandle(handle.replace(/^@/, "").toLowerCase())) {
      setError(t("profile.invalidHandle"));
      return;
    }
    if (!candidate) {
      setError(t("profile.invalidHandle"));
      return;
    }
    setProfile(candidate);
    setError(null);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-lg font-medium text-text-primary">{t("profile.title")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">{t("profile.subtitle")}</p>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div>
            <label
              htmlFor="profile-nickname"
              className="text-xs font-semibold tracking-wider text-text-tertiary uppercase"
            >
              {t("profile.nickname")}
            </label>
            <input
              id="profile-nickname"
              value={nickname}
              maxLength={40}
              onChange={(event) => setNickname(event.target.value)}
              placeholder={t("profile.nicknamePlaceholder")}
              className="mt-1.5 h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-surface px-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="profile-handle"
              className="text-xs font-semibold tracking-wider text-text-tertiary uppercase"
            >
              {t("profile.handle")}
            </label>
            <div className="mt-1.5 flex h-9 items-center rounded-(--radius-sm) border border-border-subtle bg-surface focus-within:border-border-strong">
              <span className="pl-2.5 text-sm text-text-tertiary">@</span>
              <input
                id="profile-handle"
                value={handle}
                maxLength={24}
                onChange={(event) => setHandle(event.target.value.toLowerCase())}
                placeholder="you"
                className="h-full min-w-0 flex-1 bg-transparent px-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-text-tertiary">{t("profile.handleHint")}</p>
          </div>

          <div>
            <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("profile.avatar")}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <ProfileAvatar profile={draft} size={52} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-8 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 text-xs text-text-secondary transition hover:bg-hover"
              >
                <ImagePlus size={13} /> {t("profile.uploadAvatar")}
              </button>
              {avatar && (
                <button
                  type="button"
                  onClick={() => setAvatar("")}
                  className="flex h-8 items-center gap-1.5 rounded-(--radius-sm) px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                >
                  <RotateCcw size={12} /> {t("profile.removeAvatar")}
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  pickAvatar(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("profile.accent")}
            </p>
            <div className="mt-2 flex items-center gap-2">
              {HUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`${t("profile.accent")} ${value}`}
                  aria-pressed={hue === value}
                  onClick={() => setHue(value)}
                  className={`h-6 w-6 rounded-full border-2 transition ${
                    hue === value ? "border-text-primary" : "border-transparent"
                  }`}
                  style={{ background: `hsl(${value} 72% 56%)` }}
                />
              ))}
            </div>
          </div>

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="text-xs text-success">
              {t("profile.saved")}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={save}
              className="flex h-8 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
            >
              {t("profile.save")}
            </button>
            <span className="text-xs text-text-tertiary">
              {t("profile.linkPreview", { link: `pult.local/@${draft.handle}` })}
            </span>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
            {t("profile.preview")}
          </p>
          <ProfileCard profile={draft} />
        </div>
      </div>
    </div>
  );
}
