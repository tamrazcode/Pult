import { Pencil } from "lucide-react";
import type { LocalProfile } from "../../stores/settings";
import { useT } from "../../lib/i18n";

export function profileInitials(nickname: string): string {
  const words = nickname.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

export function profileAccent(hue: number): string {
  return `hsl(${Math.round(hue)} 72% 56%)`;
}

export function ProfileAvatar({
  profile,
  size = 64,
  className = "",
}: {
  profile: LocalProfile;
  size?: number;
  className?: string;
}) {
  const accent = profileAccent(profile.avatar.hue);
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(circle at 30% 25%, ${accent}33, transparent 62%), var(--surface-raised)`,
        boxShadow: `inset 0 0 0 1px ${accent}66`,
      }}
    >
      {profile.avatar.kind === "image" && profile.avatar.value ? (
        <img
          src={profile.avatar.value}
          alt={profile.nickname}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="font-semibold tracking-tight"
          style={{ color: accent, fontSize: Math.max(13, Math.round(size * 0.3)) }}
        >
          {profileInitials(profile.nickname)}
        </span>
      )}
    </span>
  );
}

/**
 * Local identity card. Extra `meta` rows are deliberately rendered as slots so
 * future customization can append badges without changing the card shell.
 */
export function ProfileCard({
  profile,
  className = "",
  onEdit,
  meta,
}: {
  profile: LocalProfile;
  className?: string;
  onEdit?: () => void;
  meta?: Array<{ label: string; value: string }>;
}) {
  const t = useT();
  const accent = profileAccent(profile.avatar.hue);
  return (
    <section
      className={`relative overflow-hidden rounded-(--radius-lg) border border-border-strong bg-surface-raised/80 p-5 shadow-(--shadow-composer) backdrop-blur ${className}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 h-48 w-48 rounded-full blur-3xl"
        style={{ background: `${accent}2e` }}
      />
      <div className="relative flex items-center gap-4">
        <ProfileAvatar profile={profile} size={64} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-medium tracking-tight text-text-primary">
            {profile.nickname}
          </p>
          <p className="truncate text-sm text-text-tertiary">@{profile.handle}</p>
          <span
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
            style={{ color: accent, borderColor: `${accent}55`, background: `${accent}14` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
            {t("profile.localBadge")}
          </span>
        </div>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={t("profile.edit")}
            title={t("profile.edit")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <Pencil size={14} />
          </button>
        )}
      </div>
      {meta && meta.length > 0 && (
        <dl className="relative mt-4 space-y-1.5 border-t border-border-subtle pt-3">
          {meta.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-3 text-xs">
              <dt className="text-text-tertiary">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-text-secondary">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
