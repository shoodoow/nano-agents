import { describe, expect, it } from "vitest";
import { mergeWorkerBrief, repairToolInput } from "./repair-input.js";

describe("repairToolInput", () => {
  it("moves a brief written under instructions into task", () => {
    const fixed = JSON.parse(repairToolInput("spawn_worker", JSON.stringify({ instructions: "Install X and report.", kind: "shell" }))!);
    expect(fixed).toEqual({ task: "Install X and report.", kind: "shell" });
  });

  it("keeps a short title in front of the real brief", () => {
    expect(mergeWorkerBrief({ task: "Make music", instructions: "Write a 35s track to ~/work/a.mp3." }).task).toBe(
      "Make music\n\nWrite a 35s track to ~/work/a.mp3.",
    );
  });

  it("leaves custom workers alone", () => {
    const input = { task: "Do it", kind: "custom", instructions: "Standing method." };
    expect(mergeWorkerBrief(input)).toBe(input);
  });

  it("parses lists sent as text", () => {
    const fixed = JSON.parse(repairToolInput("spawn_worker", JSON.stringify({ task: "Render it", skills: '["hyperframes-cli"]' }))!);
    expect(fixed.skills).toEqual(["hyperframes-cli"]);
    const comma = JSON.parse(repairToolInput("spawn_worker", JSON.stringify({ task: "Render it", skills: "a, b" }))!);
    expect(comma.skills).toEqual(["a", "b"]);
  });

  it("parses blocks sent as a JSON string for any tool", () => {
    const fixed = JSON.parse(repairToolInput("send_message", JSON.stringify({ blocks: '[{"kind":"text","markdown":"hi"}]' }))!);
    expect(fixed.blocks).toEqual([{ kind: "text", markdown: "hi" }]);
  });

  it("returns null when there is nothing to fix", () => {
    expect(repairToolInput("read", JSON.stringify({ path: "/shared/a.md" }))).toBeNull();
    expect(repairToolInput("read", "not json")).toBeNull();
  });
});
