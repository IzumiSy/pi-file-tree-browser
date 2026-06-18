import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileRepository } from "../extensions/file-repository";

describe("FileRepository", () => {
  it("lists directories before files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-"));

    try {
      mkdirSync(path.join(root, "b-dir"));
      mkdirSync(path.join(root, "a-dir"));
      writeFileSync(path.join(root, "b.txt"), "b");
      writeFileSync(path.join(root, "a.txt"), "a");

      const repo = new FileRepository();
      expect(repo.listEntries(root).map((entry) => entry.name)).toEqual([
        "a-dir",
        "b-dir",
        "a.txt",
        "b.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads text files as editable text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-"));

    try {
      const file = path.join(root, "hello.txt");
      writeFileSync(file, "hello\nworld\n");

      const repo = new FileRepository();
      expect(repo.readEditableText(file)).toEqual({
        kind: "text",
        text: "hello\nworld\n",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns relative paths inside cwd and absolute paths outside it", () => {
    const repo = new FileRepository();
    const cwd = "/tmp/project";

    expect(repo.displayPath("/tmp/project/src/index.ts", cwd)).toBe(
      "src/index.ts",
    );
    expect(repo.displayPath("/tmp/other/index.ts", cwd)).toBe(
      "/tmp/other/index.ts",
    );
  });
});
