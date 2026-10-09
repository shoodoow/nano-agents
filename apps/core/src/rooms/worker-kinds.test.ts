import { describe, expect, test } from "vitest";
import {
  packWorkerJobDescription,
  unpackWorkerJobDescription,
  workerPreambleFor,
  WORKER_KINDS,
} from "./worker-kinds.js";

describe("worker kinds", () => {
  test("every built-in kind loads a prompt", () => {
    for (const kind of WORKER_KINDS) {
      if (kind === "custom") continue;
      const text = workerPreambleFor(kind);
      expect(text.length).toBeGreaterThan(40);
      expect(text).toContain("Findings:");
      expect(text).toContain("/shared/worker-results/");
      expect(text).toContain("no voice in any room");
    }
  });

  test("preamble carries a step budget so workers stop in time to report", () => {
    const text = workerPreambleFor("executor");
    expect(text).toContain("Step budget: 10 steps");
    expect(workerPreambleFor("executor", undefined, 25)).toContain("Step budget: 25 steps");
    expect(workerPreambleFor("browser")).toContain("Step budget: 10 steps");
  });

  test("custom requires instructions", () => {
    expect(() => workerPreambleFor("custom")).toThrow(/instructions/);
    expect(workerPreambleFor("custom", "Only list open ports.")).toContain("Only list open ports.");
  });

  test("pack/unpack round-trips built-in and custom", () => {
    const packed = packWorkerJobDescription({ kind: "explore", jobDescription: "Find the schema." });
    expect(unpackWorkerJobDescription(packed)).toEqual({
      kind: "explore",
      jobDescription: "Find the schema.",
    });

    const custom = packWorkerJobDescription({
      kind: "custom",
      jobDescription: "Ship the report.",
      instructions: "Use CSV only.\nNo screenshots.",
    });
    expect(unpackWorkerJobDescription(custom)).toEqual({
      kind: "custom",
      jobDescription: "Ship the report.",
      instructions: "Use CSV only.\nNo screenshots.",
    });
  });

  test("legacy job descriptions default to computer", () => {
    expect(unpackWorkerJobDescription("Do the desktop thing.")).toEqual({
      kind: "computer",
      jobDescription: "Do the desktop thing.",
    });
  });
});
