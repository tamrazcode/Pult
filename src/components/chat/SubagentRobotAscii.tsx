import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

/** A rectangular robot head with an antenna, in the same ASCII frame style as
 *  ThinkingAscii. Shown when the thread itself is idle but a subagent works. */
const FRAMES = [
  "  o  \n  |  \n+---+\n|o o|\n+---+",
  "  o  \n  |  \n+---+\n|o o|\n+---+",
  "  o  \n  |  \n+---+\n|- -|\n+---+",
  "  o  \n  |  \n+---+\n|o o|\n+---+",
];

export function SubagentRobotAscii() {
  const t = useT();
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 90);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span
      data-subagent-robot
      aria-label={t("subagents.status.running")}
      title={t("subagents.status.running")}
      className="inline-block font-mono text-[6px] leading-[6px] whitespace-pre text-accent"
    >
      {FRAMES[frame]}
    </span>
  );
}
