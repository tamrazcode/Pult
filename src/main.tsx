import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ensureRunEventSubscriptions, resyncLiveState } from "./lib/runEvents";
import { translate } from "./lib/i18n";
import { useUiStore } from "./stores/ui";
import { threadsDelete } from "./lib/ipc";
import { useGitStore } from "./stores/git";
import { useRunsStore } from "./stores/runs";
import { useSettingsStore } from "./stores/settings";
import { useThreadsStore } from "./stores/threads";
import "./styles/index.css";

// Global backend event fan-in (run events, run:started, queue updates). A
// transient registration failure is retried; after a successful (re)attach the
// stores re-read the authoritative state, so nothing missed stays missing.
// shortcut: a partial registration that later succeeds can keep the first
// attempt's listeners; run events dedupe by id, but refactor to an offs array
// if this retry path ever becomes common.
async function startEventFanIn(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await ensureRunEventSubscriptions();
      await resyncLiveState();
      return;
    } catch (err) {
      console.error("event subscriptions failed", err);
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  useUiStore.getState().setGlobalError({
    kind: "protocol",
    message: translate("common.liveUpdatesFailed"),
  });
}
void startEventFanIn();

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
