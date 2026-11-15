import { Composer } from "./Composer";
import { LivingAscii } from "./LivingAscii";
import { useProjectsStore } from "../../stores/projects";

/** First-run screen: live ASCII field, prompt, and the composer. */
export function NewChatEmptyState() {
  const project = useProjectsStore((s) =>
    s.projects.find((candidate) => candidate.id === s.selectedProjectId),
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto">
      <LivingAscii />
      <div className="relative z-10 w-full -translate-y-3 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 text-center">
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">
            What should we work on?
          </h1>
          <p className="mt-1.5 max-w-md text-sm text-text-tertiary">
            {project ? project.name : "No project"}
          </p>
        </div>
        <div className="mt-7">
          <Composer />
        </div>
      </div>
    </div>
  );
}
