import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ElicitationModal } from "../src/components/chat/ElicitationModal";
import type { ElicitationRequest } from "../src/components/chat/ElicitationModal";

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, openExternalUrl };
});

const MESSAGE = "The agent needs input to continue";

function makeRequest(
  detail: Record<string, unknown>,
  message: string = MESSAGE,
): ElicitationRequest {
  return { runId: "run-1", requestId: "req-1", message, detail };
}

describe("ElicitationModal", () => {
  it("form mode: renders message and fields, accepts with collected content", async () => {
    const onSubmit = vi.fn();
    render(
      <ElicitationModal
        request={makeRequest(
          {
            mode: "form",
            requestedSchema: {
              type: "object",
              title: "Setup",
              properties: {
                name: { type: "string", title: "Project name" },
                color: { type: "string", title: "Color", enum: ["red", "green", "blue"] },
              },
              required: ["name"],
            },
          },
          "Configure the project before running",
        )}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Configure the project before running" }),
    ).toBeVisible();
    expect(screen.getByText("Configure the project before running")).toBeVisible();

    await userEvent.type(screen.getByLabelText("Project name"), "Ada");
    await userEvent.selectOptions(screen.getByLabelText("Color"), "red");
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("accept", { name: "Ada", color: "red" });
  });

  it("form mode: Accept stays disabled while a required field is empty", async () => {
    const onSubmit = vi.fn();
    render(
      <ElicitationModal
        request={makeRequest({
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: { name: { type: "string", title: "Project name" } },
            required: ["name"],
          },
        })}
        onSubmit={onSubmit}
      />,
    );

    const accept = screen.getByRole("button", { name: "Accept" });
    expect(accept).toBeDisabled();

    await userEvent.click(accept);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("form mode: number and boolean props are sent as real values", async () => {
    const onSubmit = vi.fn();
    render(
      <ElicitationModal
        request={makeRequest({
          mode: "form",
          requestedSchema: {
            type: "object",
            properties: {
              count: { type: "integer", title: "Count" },
              flag: { type: "boolean", title: "Flag" },
            },
            required: ["count"],
          },
        })}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.type(screen.getByLabelText("Count"), "42");
    await userEvent.click(screen.getByLabelText("Flag"));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("accept", { count: 42, flag: true });
  });

  it("url mode: opens the link before accepting", async () => {
    openExternalUrl.mockReset().mockResolvedValue(undefined);
    const onSubmit = vi.fn();
    render(
      <ElicitationModal
        request={makeRequest({ mode: "url", url: "https://example.com/connect" })}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("https://example.com/connect")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/connect");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("accept");

    expect(screen.getByRole("button", { name: "Decline" })).toBeVisible();
  });

  it("url mode: a failed open shows the error and does not accept", async () => {
    openExternalUrl.mockReset().mockRejectedValue(new Error("no browser"));
    const onSubmit = vi.fn();
    render(
      <ElicitationModal
        request={makeRequest({ mode: "url", url: "https://example.com/connect" })}
        onSubmit={onSubmit}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open URL" }));
    expect(openExternalUrl).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/no browser/);
  });

  it("unknown mode: shows the hint and Decline reports decline", async () => {
    const onSubmit = vi.fn();
    render(
      <ElicitationModal request={makeRequest({ mode: "carrier-pigeon" })} onSubmit={onSubmit} />,
    );

    expect(screen.getByText("The agent sent an unknown request mode")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("decline");
  });
});
