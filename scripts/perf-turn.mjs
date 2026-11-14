#!/usr/bin/env node
// Runs the Rust perf_turn example for one agent and prints a compact table.
import { spawnSync } from "node:child_process";

const agent = process.argv[2] ?? "mock";
const result = spawnSync(
  "cargo",
  [
    "run",
    "--quiet",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "perf_turn",
    "--",
    agent,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const rows = result.stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
console.table(rows);
