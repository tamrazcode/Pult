import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Testing Library registers auto-cleanup via global afterEach; vitest runs without
// globals here, so we do it explicitly.
afterEach(() => {
  cleanup();
});
