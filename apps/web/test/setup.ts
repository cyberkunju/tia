// Vitest global setup. Runs once per test file before the tests.
// - jest-dom/vitest wires the DOM matchers (toBeInTheDocument, etc.) into
//   vitest's `expect`.
// - cleanup() unmounts any rendered tree after each test.
// - localStorage is wiped so the persisted Zustand store starts each test from
//   its coded defaults instead of leaking state across tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* no localStorage in this context — ignore */
  }
});
