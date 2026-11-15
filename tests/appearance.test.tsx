import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Route } from "../src/routes/settings.appearance";
import { THEMES } from "../src/lib/theme";
import { useSettingsStore } from "../src/stores/settings";

const AppearanceSettings = Route.options.component!;

describe("AppearanceSettings theme previews", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.theme;
    useSettingsStore.setState({ theme: "dark", accentHue: null });
  });

  it("renders all 4 theme radio cards with scoped data-theme miniature previews while root stays dark", () => {
    const { container } = render(<AppearanceSettings />);

    expect(document.documentElement.getAttribute("data-theme")).toBeNull();

    for (const { id, label } of THEMES) {
      const card = screen.getByRole("radio", { name: label });
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

    const liquidCard = screen.getByRole("radio", { name: "Liquid Glass" });
    const liquidPreview = liquidCard.querySelector<HTMLElement>('[data-theme="liquid"]');
    expect(liquidPreview, "Liquid Glass preview wrapper should exist").not.toBeNull();
    const hasGlassSurface =
      liquidPreview!.classList.contains("glass-surface") ||
      liquidPreview!.querySelector(".glass-surface") !== null;
    expect(hasGlassSurface, "Liquid Glass preview should use glass-surface").toBe(true);

    expect(container.querySelectorAll("[data-theme]").length).toBe(4);
  });
});
