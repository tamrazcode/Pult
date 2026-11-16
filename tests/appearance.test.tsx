import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { settingsGet, settingsSet } = vi.hoisted(() => ({
  settingsGet: vi.fn(async (_key: string): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    settingsGet,
    settingsSet,
  };
});

import { Route } from "../src/routes/settings.appearance";
import { THEMES } from "../src/lib/theme";
import { translate } from "../src/lib/i18n";
import { useSettingsStore } from "../src/stores/settings";

const AppearanceSettings = Route.options.component!;

describe("AppearanceSettings theme previews", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);
    useSettingsStore.setState({ theme: "dark", accentHue: null, glassOpacity: 100 });
  });

  it("renders all 3 theme radio cards with scoped data-theme miniature previews while root stays dark", () => {
    const { container } = render(<AppearanceSettings />);

    expect(document.documentElement.getAttribute("data-theme")).toBeNull();

    for (const { id, labelKey } of THEMES) {
      const label = translate(labelKey);
      const card = screen.getByRole("radio", {
        name: id === "graphite" ? new RegExp(`^${label}`) : label,
      });
      const themed = card.querySelector<HTMLElement>(`[data-theme="${id}"]`);
      expect(themed, `${label} card should contain [data-theme="${id}"]`).not.toBeNull();

      const hasCanvas =
        themed!.classList.contains("bg-canvas") || themed!.querySelector(".bg-canvas") !== null;
      expect(hasCanvas, `${label} preview should have bg-canvas`).toBe(true);

      const miniatureSurface = themed!.querySelector(".bg-panel, .bg-surface, .bg-chrome");
      expect(
        miniatureSurface,
        `${label} preview should contain bg-panel, bg-surface, or bg-chrome`,
      ).not.toBeNull();
    }

    expect(container.querySelectorAll("[data-theme]").length).toBe(3);
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("renders a Glass opacity range input defaulting to 100 and persists changes", () => {
    render(<AppearanceSettings />);

    const slider = screen.getByLabelText("Glass opacity") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.value).toBe("100");
    expect(useSettingsStore.getState().glassOpacity).toBe(100);

    fireEvent.change(slider, { target: { value: "40" } });

    expect(useSettingsStore.getState().glassOpacity).toBe(40);
    expect(slider.value).toBe("40");
    expect(settingsSet).toHaveBeenCalledWith("glass_opacity", 40);
  });

  it("hydrates glass_opacity from settingsGet and clamps or resets invalid values", async () => {
    settingsGet.mockImplementation(async (key: string) => (key === "glass_opacity" ? 40 : null));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().glassOpacity).toBe(40);

    settingsGet.mockImplementation(async (key: string) => (key === "glass_opacity" ? 150 : null));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().glassOpacity).toBe(100);

    settingsGet.mockImplementation(async (key: string) => (key === "glass_opacity" ? -20 : null));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().glassOpacity).toBe(0);

    settingsGet.mockImplementation(async (key: string) =>
      key === "glass_opacity" ? "not-a-number" : null,
    );
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().glassOpacity).toBe(100);
  });
});
