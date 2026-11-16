import { appNotify } from "./ipc";
import { playNotificationSound, type NotificationSound } from "./sound";
import { useSettingsStore } from "../stores/settings";

/**
 * Notify only when the user is not looking at Pult; a focused window already
 * shows the result, and Windows toasts would be noise.
 */
export function notifyRunFinished(kind: NotificationSound, title: string, body: string): void {
  if (typeof document === "undefined") return;
  const settings = useSettingsStore.getState();
  if (!settings.notificationsEnabled) return;
  if (!document.hidden && document.hasFocus()) return;
  if (settings.notificationSound) playNotificationSound(kind);
  void appNotify(title, body).catch(() => {
    // OS notifications can be disabled at the system level; sound still played.
  });
}
