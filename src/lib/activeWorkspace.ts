import { useProjectsStore } from "../stores/projects";
import { useThreadsStore } from "../stores/threads";
import { useUiStore } from "../stores/ui";

/** Thread workspace, falling back to its project root, then the global root. */
export function activeWorkspaceRoot(): string | null {
  const threads = useThreadsStore.getState();
  const thread = threads.threads.find((candidate) => candidate.id === threads.activeThreadId);
  if (thread?.workspace) return thread.workspace;
  // A projectless thread must not inherit the project selected before it.
  const projectId = thread ? thread.projectId : useProjectsStore.getState().selectedProjectId;
  if (projectId) {
    const root = useProjectsStore
      .getState()
      .projects.find((project) => project.id === projectId)?.rootPath;
    if (root) return root;
  }
  return useUiStore.getState().globalWorkspaceRoot;
}
