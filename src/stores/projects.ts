import { create } from "zustand";
import { projectsCreate, projectsDelete, projectsList, projectsUpdate } from "../lib/ipc";
import type { Project } from "../lib/types";

export const PROJECT_COLORS = [
  "#346bf1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
];

/** Stable color for a project name (same name -> same swatch). */
export function projectColorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

interface ProjectsState {
  projects: Project[];
  selectedProjectId: string | null;
  loaded: boolean;
  loadProjects: () => Promise<void>;
  selectProject: (id: string | null) => void;
  createProject: (
    name: string,
    rootPath: string,
    color?: string | null,
    worktreeStrategy?: "root" | "worktree",
  ) => Promise<Project>;
  updateProject: (
    id: string,
    patch: {
      name?: string;
      color?: string | null;
      worktreeStrategy?: "root" | "worktree";
      pinned?: boolean;
    },
  ) => Promise<Project>;
  togglePin: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  selectedProjectId: null,
  loaded: false,

  loadProjects: async () => {
    const projects = await projectsList();
    set({ projects, loaded: true });
  },

  selectProject: (selectedProjectId) => set({ selectedProjectId }),

  createProject: async (name, rootPath, color, worktreeStrategy) => {
    const project = await projectsCreate(name, rootPath, color, worktreeStrategy);
    set((s) => ({ projects: [...s.projects, project], selectedProjectId: project.id }));
    return project;
  },

  updateProject: async (id, patch) => {
    const project = await projectsUpdate(id, patch);
    set((s) => ({
      projects: s.projects.map((candidate) => (candidate.id === id ? project : candidate)),
    }));
    return project;
  },

  togglePin: async (id) => {
    const project = get().projects.find((candidate) => candidate.id === id);
    if (!project) return;
    await get().updateProject(id, { pinned: !project.pinned });
  },

  deleteProject: async (id) => {
    await projectsDelete(id);
    set((s) => ({
      projects: s.projects.filter((project) => project.id !== id),
      selectedProjectId: s.selectedProjectId === id ? null : s.selectedProjectId,
    }));
  },
}));
