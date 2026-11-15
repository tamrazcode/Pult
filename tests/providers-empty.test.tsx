import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Route } from "../src/routes/settings.providers";

const ProvidersSettings = Route.options.component!;

describe("ProvidersSettings empty state", () => {
  it("shows a first-run empty state and an add action outside Tauri", () => {
    render(<ProvidersSettings />);
    expect(screen.getByText("No providers yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /add provider/i }).length).toBeGreaterThan(0);
  });
});
