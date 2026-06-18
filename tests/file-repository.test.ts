import { spawnSync } from "node:child_process";
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

  it("resets foreground color on every highlighted preview line", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-"));

    try {
      const file = path.join(root, "comment.ts");
      writeFileSync(file, "/*\ncomment\n*/\nconst x = 1;\n");

      const repo = new FileRepository();
      const preview = repo.readPreview(file);
      const lines = repo.renderPreviewLines(file, preview);

      expect(lines).toHaveLength(5);
      expect(lines.every((line) => line.endsWith("\x1b[39m"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extends the buffered preview cache incrementally while scrolling", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-"));

    try {
      const file = path.join(root, "large.ts");
      writeFileSync(file, `${"const x = 1;\n".repeat(12000)}`);

      const highlightedChunks: string[] = [];
      const repo = new FileRepository((code) => {
        highlightedChunks.push(code);
        return code.split("\n");
      });
      const preview = repo.readPreview(file);
      const lines = repo.renderPreviewLines(file, preview, 100, 3);

      expect(preview.highlight).toBe(true);
      expect(lines).toHaveLength(3);
      expect(lines.every((line) => line.endsWith("\x1b[39m"))).toBe(true);
      expect(preview.renderedWindow).toMatchObject({ start: 60, end: 143 });
      expect(highlightedChunks).toHaveLength(1);
      expect(highlightedChunks[0]?.split("\n")).toHaveLength(83);

      const nearbyLines = repo.renderPreviewLines(file, preview, 101, 3);
      expect(nearbyLines).toHaveLength(3);
      expect(preview.renderedWindow).toMatchObject({ start: 61, end: 144 });
      expect(highlightedChunks).toHaveLength(2);
      expect(highlightedChunks[1]?.split("\n")).toHaveLength(21);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists tracked files and their parent directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-"));

    try {
      writeFileSync(path.join(root, "tracked.ts"), "export const tracked = true;\n");
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "src", "nested.ts"), "export const nested = true;\n");

      expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);

      const repo = new FileRepository();
      expect(repo.listTrackedFiles(root).map((file) => file.relativePath)).toEqual([
        "src",
        "src/nested.ts",
        "tracked.ts",
      ]);
      expect(repo.listTrackedFiles(root).map((file) => file.isDirectory)).toEqual([
        true,
        false,
        false,
      ]);
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
