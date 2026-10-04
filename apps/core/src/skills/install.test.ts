import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { catalogText, parseSkillSource, writeAccountSkill } from "./install.js";
import { readSkillForAccount } from "./skills.js";

const account = "11111111-1111-4111-8111-111111111111";
let root = "";

describe("skill install", () => {
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("rejects a global-style source and accepts owner/repo@skill", () => {
    expect(() => parseSkillSource("-g")).toThrow(/owner\/repo/);
    expect(parseSkillSource("mvanhorn/last30days-skill@last30days")).toEqual({
      owner: "mvanhorn",
      repo: "last30days-skill",
      skill: "last30days",
    });
  });

  it("writes into the account folder and lists it without a restart", async () => {
    root = await mkdtemp(join(tmpdir(), "nano-install-"));
    const markdown = "---\nname: last30days\ndescription: Recent trends.\n---\n\nRun the engine.\n";
    expect(writeAccountSkill(root, account, markdown)).toEqual({ name: "last30days" });
    expect(readSkillForAccount(root, account, "last30days")).toContain("Run the engine.");
    expect(catalogText(root, account)).toContain("last30days: Recent trends.");
  });
});
