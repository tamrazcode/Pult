/** True when running inside the Tauri webview (vs a plain `pnpm dev` browser tab). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
