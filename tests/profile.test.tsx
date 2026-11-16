import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { settingsSet } = vi.hoisted(() => ({
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    settingsSet,
  };
});

import { ProfileCard } from "../src/components/profile/ProfileCard";
import { sanitizeProfile, useSettingsStore, type LocalProfile } from "../src/stores/settings";

describe("local profile", () => {
  beforeEach(() => {
    settingsSet.mockReset().mockResolvedValue(undefined);
    useSettingsStore.setState({ profile: null });
  });

  it("sanitizeProfile rejects empty nickname and bad handles", () => {
    expect(sanitizeProfile(null)).toBeNull();
    expect(sanitizeProfile({ nickname: "   ", handle: "alice" })).toBeNull();
    expect(sanitizeProfile({ nickname: "Alice", handle: "" })).toBeNull();
    expect(sanitizeProfile({ nickname: "Alice", handle: "a" })).toBeNull();
    expect(sanitizeProfile({ nickname: "Alice", handle: "bad-handle!" })).toBeNull();
  });

  it("sanitizeProfile accepts valid image data URLs, rejects non-image URLs, and clamps hue", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const withImage = sanitizeProfile({
      nickname: "  Ada Lovelace  ",
      handle: "@Ada_99",
      avatar: { kind: "image", value: dataUrl, hue: 400 },
    });
    expect(withImage).toEqual({
      version: 1,
      nickname: "Ada Lovelace",
      handle: "ada_99",
      avatar: {
        kind: "image",
        value: dataUrl,
        hue: 40,
      },
    });

    const withBadUrlAndNegativeHue = sanitizeProfile({
      nickname: "Bob",
      handle: "bob_dev",
      avatar: { kind: "image", value: "https://example.com/avatar.png", hue: -25 },
    });
    expect(withBadUrlAndNegativeHue).toEqual({
      version: 1,
      nickname: "Bob",
      handle: "bob_dev",
      avatar: {
        kind: "initials",
        value: "",
        hue: 0,
      },
    });
  });

  it("setProfile updates the settings store and persists via settingsSet", () => {
    const profile: LocalProfile = {
      version: 1,
      nickname: "Grace Hopper",
      handle: "grace",
      avatar: { kind: "initials", value: "", hue: 188 },
    };

    useSettingsStore.getState().setProfile(profile);

    expect(useSettingsStore.getState().profile).toEqual(profile);
    expect(settingsSet).toHaveBeenCalledWith("profile", profile);
  });

  it("ProfileCard renders nickname, @handle, local badge, and initials", () => {
    const profile: LocalProfile = {
      version: 1,
      nickname: "Ada Lovelace",
      handle: "ada_l",
      avatar: { kind: "initials", value: "", hue: 215 },
    };

    render(<ProfileCard profile={profile} />);

    expect(screen.getByText("Ada Lovelace")).toBeVisible();
    expect(screen.getByText("@ada_l")).toBeVisible();
    expect(screen.getByText("Local profile")).toBeVisible();
    expect(screen.getByText("AL")).toBeVisible();
  });
});
