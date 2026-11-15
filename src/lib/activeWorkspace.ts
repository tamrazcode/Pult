import { useProjectsStore } from "../stores/projects";
import { useThreadsStore } from "../stores/threads";

/** Thread workspace, falling back to its project root when the thread has none. */
export function activeWorkspaceRoot(): string | null {
  const threads = useThreadsStore.getState();
  const thread = threads.threads.find((candidate) => candidate.id === threads.activeThreadId);
  if (thread?.workspace) return thread.workspace;
  const projectId = thread?.projectId ?? useProjectsStore.getState().selectedProjectId;
  if (!projectId) return null;
  return (
    useProjectsStore.getState().projects.find((project) => project.id === projectId)?.rootPath ??
    null
  );
}
