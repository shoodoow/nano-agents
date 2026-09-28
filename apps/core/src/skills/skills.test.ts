import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readSkill, skillCatalog } from "./skills.js";

const bodySentence = "Alpha body stays out of the catalog.";
let root = "";

describe("skills", () => {
  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists name and description in order, and loads a body only by name", async () => {
    root = await mkdtemp(join(tmpdir(), "nano-skills-"));
    await writeSkill(root, "zeta", "zeta", "Zeta work.", "Zeta body stays out of the catalog.");
    await writeSkill(root, "alpha", "alpha", "Alpha work.", bodySentence);

    const catalog = skillCatalog(root);
    expect(catalog).toEqual([
      { name: "alpha", description: "Alpha work." },
      { name: "zeta", description: "Zeta work." },
    ]);
    expect(catalog.map((skill) => `${skill.name}: ${skill.description}`).join("\n").includes(bodySentence)).toBe(false);
    expect(readSkill(root, "alpha")).toBe(bodySentence);
    expect(() => readSkill(root, "missing")).toThrow(/missing/);
  });
});

async function writeSkill(directory: string, folder: string, name: string, description: string, body: string) {
  const skillDirectory = join(directory, folder);
  await mkdir(skillDirectory);
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}
