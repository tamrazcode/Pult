import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ProviderLogo, detectProviderBrand } from "../src/components/chat/ProviderLogo";

const antigravity = {
  id: "antigravity",
  driver: "acp",
  displayName: "Google Antigravity",
  command:
    "C:\\Users\\dev\\.t3\\tools\\antigravity-acp\\win32-x64\\versions\\x\\agy_acp_server.exe",
  args: [],
};

describe("ProviderLogo", () => {
  it("detects Antigravity as its own brand instead of Gemini", () => {
    expect(detectProviderBrand(antigravity)).toBe("antigravity");
  });

  it("renders the bundled Antigravity mark", () => {
    const { container } = render(<ProviderLogo instance={antigravity} />);
    expect(container.querySelector('[data-provider-logo="antigravity"]')).toBeInTheDocument();
  });

  it.each([
    ["cursor", "Cursor", "cursor-agent", ["acp"]],
    ["grok", "Grok", "grok", ["agent", "stdio"]],
    ["muse", "Muse Code", "muse", ["acp"]],
    ["pi", "Pi", "pi", ["--mode", "rpc"]],
  ] as const)("renders the %s provider mark", (brand, displayName, command, args) => {
    const instance = {
      id: brand,
      driver: "acp",
      displayName,
      command,
      args: [...args],
    };
    expect(detectProviderBrand(instance)).toBe(brand);
    const { container } = render(<ProviderLogo instance={instance} />);
    expect(container.querySelector(`[data-provider-logo="${brand}"]`)).toBeInTheDocument();
  });
});
