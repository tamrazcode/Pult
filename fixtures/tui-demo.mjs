// TUI demo for the M5 terminal acceptance: a `top`-style full-screen ANSI
// dashboard — alternate screen buffer, cursor positioning, colors, box
// drawing, live-updating rows and a progress bar. Runs for ~12 s then exits.
import { setInterval, clearInterval } from "node:timers";

const CLEAR = "\x1b[2J";
const HOME = "\x1b[H";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const ALT_IN = "\x1b[?1049h";
const ALT_OUT = "\x1b[?1049l";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function bar(value, width) {
  const filled = Math.round((value / 100) * width);
  const color = value > 75 ? C.red : value > 45 ? C.yellow : C.green;
  return `${color}${"█".repeat(filled)}${C.dim}${"░".repeat(width - filled)}${C.reset}`;
}

const rows = [
  { name: "mock-agent", cpu: 20, mem: "48 MB" },
  { name: "pult-core", cpu: 10, mem: "96 MB" },
  { name: "tui-demo", cpu: 2, mem: "12 MB" },
];

const start = Date.now();
function render() {
  const elapsed = Math.floor((Date.now() - start) / 1000);
  const load = 40 + Math.round(30 * Math.sin(Date.now() / 900));
  const clock = new Date().toLocaleTimeString();
  const width = 46;
  const line = (l, r) => `${l}${" ".repeat(Math.max(1, width - 2 - l.length - r.length))}${r}`;
  let out = HOME;
  out += `${C.cyan}╭${"─".repeat(width - 2)}╮${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${C.bold} pult TUI demo${C.reset}${line("", `${C.dim}up ${elapsed}s${C.reset}`)}${C.cyan}│${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${line(` ${C.dim}time${C.reset} ${clock}`, `${C.dim}cols${C.reset} ${width}`)}${C.cyan}│${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${line(` ${C.dim}load${C.reset} ${bar(load, 24)} ${load}%`, "")}${C.cyan}│${C.reset}\n`;
  out += `${C.cyan}├${"─".repeat(width - 2)}┤${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${C.bold}  ${"PROCESS".padEnd(18)}${"CPU".padStart(6)}  ${"MEM".padStart(8)}${C.reset} ${C.cyan}│${C.reset}\n`;
  for (const row of rows) {
    row.cpu = Math.max(1, Math.min(95, row.cpu + Math.round((Math.random() - 0.5) * 10)));
    const color = row.cpu > 70 ? C.red : row.cpu > 40 ? C.yellow : C.green;
    out += `${C.cyan}│${C.reset}${line(
      `  ${C.magenta}${row.name.padEnd(18)}${C.reset} ${color}${String(row.cpu).padStart(4)}%${C.reset}  ${row.mem.padStart(8)}`,
      "",
    )}${C.cyan}│${C.reset}\n`;
  }
  out += `${C.cyan}├${"─".repeat(width - 2)}┤${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${line(
    ` ${C.dim}ConPTY → xterm.js: colors, cursor,${C.reset}`,
    "",
  )}${C.cyan}│${C.reset}\n`;
  out += `${C.cyan}│${C.reset}${line(` ${C.dim}box-drawing, live redraws.${C.reset}`, "")}${C.cyan}│${C.reset}\n`;
  out += `${C.cyan}╰${"─".repeat(width - 2)}╯${C.reset}\n`;
  process.stdout.write(out);
}

process.stdout.write(ALT_IN + HIDE + CLEAR);
render();
const timer = setInterval(render, 180);
setTimeout(() => {
  clearInterval(timer);
  process.stdout.write(SHOW + ALT_OUT + "tui-demo finished cleanly\r\n");
  process.exit(0);
}, 12000);
