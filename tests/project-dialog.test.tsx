import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Project } from "../src/lib/types";

const { navigate, pickFolder, projectsCreate, projectsUpdate, projectsDelete, projectsList } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    pickFolder: vi.fn(),
    projectsCreate: vi.fn(),
    projectsUpdate: vi.fn(),
    projectsDelete: vi.fn(),
    projectsList: vi.fn(),
  }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickFolder,
    projectsCreate,
    projectsUpdate,
    projectsDelete,
    projectsList,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { CreateProjectDialog } from "../src/components/projects/CreateProjectDialog";
import { ProjectSettingsDialog } from "../src/components/projects/ProjectSettingsDialog";
import { WorkspaceStrategyRadio } from "../src/components/projects/WorkspaceStrategyRadio";
import { PROJECT_COLORS, useProjectsStore } from "../src/stores/projects";

const SEEDED_PROJECT: Project = {
  id: "proj-1",
  name: "Alpha",
  rootPath: "C:\\work\\alpha",
  color: "#346bf1",
  worktreeStrategy: "root",
  pinned: false,
  createdAt: 1000,
};

describe("WorkspaceStrategyRadio", () => {
  it("uses hidden peer radio inputs, visible checked dots, and supports click and keyboard selection", async () => {
    function Strategies() {
      const [strategy, setStrategy] = useState("root");
      return (
        <>
          {["root", "worktree"].map((value) => (
            <WorkspaceStrategyRadio
              key={value}
              name="strategy"
              label={value}
              checked={strategy === value}
              onChange={() => setStrategy(value)}
            />
          ))}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Strategies />);
    const root = screen.getByRole("radio", { name: "root" });
    const worktree = screen.getByRole("radio", { name: "worktree" });
    const dot = (radio: HTMLElement) => radio.nextElementSibling!.firstElementChild!;
    for (const radio of [root, worktree]) {
      expect(radio.tagName).toBe("INPUT");
      expect(radio).toHaveClass("peer", "sr-only");
      expect(dot(radio)).toHaveClass("rounded-full", "bg-accent");
    }
    expect(root).toBeChecked();
    expect(dot(root)).toHaveClass("opacity-100");
    expect(dot(worktree)).toHaveClass("opacity-0");
    await user.click(screen.getByText("worktree"));
    expect(worktree).toBeChecked();
    expect(root).not.toBeChecked();
    expect(dot(worktree)).toHaveClass("opacity-100");
    expect(dot(root)).toHaveClass("opacity-0");
    expect(worktree).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(root).toBeChecked();
    expect(root).toHaveFocus();
    expect(dot(root)).toHaveClass("opacity-100");
    await user.keyboard("{ArrowRight}");
    expect(worktree).toBeChecked();
    expect(worktree).toHaveFocus();
  });
});

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    pickFolder.mockReset();
    projectsCreate.mockReset();
    projectsUpdate.mockReset();
    projectsDelete.mockReset();
    projectsList.mockReset().mockResolvedValue([]);
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
  });

  it("clicking Choose folder calls pickFolder, fills root path, and derives name from basename", async () => {
    pickFolder.mockResolvedValueOnce("C:\\work\\my-project");
    render(<CreateProjectDialog open={true} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    expect(screen.getByText("C:\\work\\my-project")).toBeVisible();
    expect(screen.getByLabelText(/name/i)).toHaveValue("my-project");
  });

  it("cancelling pickFolder leaves name empty and submitting does not call projectsCreate", async () => {
    pickFolder.mockResolvedValueOnce(null);
    render(<CreateProjectDialog open={true} onClose={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    expect(screen.getByLabelText(/name/i)).toHaveValue("");

    const submit = screen.getByRole("button", { name: /create/i });
    await userEvent.click(submit);

    expect(projectsCreate).not.toHaveBeenCalled();
  });

  it("submitting CreateProjectDialog calls projectsCreate with trimmed name, rootPath, color, and worktreeStrategy", async () => {
    const selectedColor = PROJECT_COLORS[1];
    const created: Project = {
      id: "proj-new",
      name: "My Project",
      rootPath: "C:\\work\\my-project",
      color: selectedColor,
      worktreeStrategy: "worktree",
      pinned: false,
      createdAt: 2000,
    };
    pickFolder.mockResolvedValueOnce("C:\\work\\my-project");
    projectsCreate.mockResolvedValueOnce(created);
    const onClose = vi.fn();

    render(<CreateProjectDialog open={true} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    const nameInput = screen.getByLabelText(/name/i);
    await waitFor(() => expect(nameInput).toHaveValue("my-project"));

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "  My Project  ");
    await userEvent.click(screen.getByRole("button", { name: new RegExp(selectedColor, "i") }));
    await userEvent.click(screen.getByText(/git worktree/i));
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() =>
      expect(projectsCreate).toHaveBeenCalledWith(
        "My Project",
        "C:\\work\\my-project",
        selectedColor,
        "worktree",
      ),
    );
    expect(useProjectsStore.getState().selectedProjectId).toBe("proj-new");
    expect(onClose).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: "/chat" });
  });
});

describe("ProjectSettingsDialog", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    pickFolder.mockReset();
    projectsCreate.mockReset();
    projectsUpdate.mockReset();
    projectsDelete.mockReset();
    projectsList.mockReset().mockResolvedValue([SEEDED_PROJECT]);
    useProjectsStore.setState({
      projects: [SEEDED_PROJECT],
      selectedProjectId: SEEDED_PROJECT.id,
    });
  });

  it("editing name and submitting calls projectsUpdate with trimmed name", async () => {
    const updated: Project = { ...SEEDED_PROJECT, name: "Alpha Renamed" };
    projectsUpdate.mockResolvedValueOnce(updated);
    const onClose = vi.fn();

    render(<ProjectSettingsDialog open={true} projectId={SEEDED_PROJECT.id} onClose={onClose} />);

    const nameInput = screen.getByLabelText(/name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "  Alpha Renamed  ");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(projectsUpdate).toHaveBeenCalledWith(
        SEEDED_PROJECT.id,
        expect.objectContaining({ name: "Alpha Renamed" }),
      ),
    );
    expect(useProjectsStore.getState().projects[0].name).toBe("Alpha Renamed");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("requires confirmation click before calling projectsDelete", async () => {
    projectsDelete.mockResolvedValueOnce(undefined);
    const onClose = vi.fn();

    render(<ProjectSettingsDialog open={true} projectId={SEEDED_PROJECT.id} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(projectsDelete).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(projectsDelete).toHaveBeenCalledWith(SEEDED_PROJECT.id));
    expect(useProjectsStore.getState().projects).toHaveLength(0);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
