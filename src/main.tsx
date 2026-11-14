import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ensureRunEventSubscriptions } from "./lib/runEvents";
import { threadsDelete } from "./lib/ipc";
import { useGitStore } from "./stores/git";
import { useRunsStore } from "./stores/runs";
import { useSettingsStore } from "./stores/settings";
import { useThreadsStore } from "./stores/threads";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";

// Global backend event fan-in (run events, run:started, queue updates).
void ensureRunEventSubscriptions();

// Appearance + permission settings persist per §4.5; hydrate applies the
// stored theme/accent as soon as it resolves.
void useSettingsStore.getState().hydrate();

// Dev/acceptance hook: lets automation read store state without DOM scraping.
Object.assign(window as unknown as Record<string, unknown>, {
  __pult: {
    git: useGitStore,
    runs: useRunsStore,
    threads: useThreadsStore,
    settings: useSettingsStore,
    threadsDelete,
  },
});

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
