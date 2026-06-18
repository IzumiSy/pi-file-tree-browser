import { describe, expect, it } from "vitest";
import { FileTreeModel, PreviewModel } from "../extensions/file-browser";
import type { PreviewData, TreeEntry } from "../extensions/file-repository";

class FakeFileRepository {
  constructor(
    private readonly entries: Record<string, TreeEntry[]>,
    private readonly previews: Record<string, PreviewData> = {},
  ) {}

  listEntries(dir: string): TreeEntry[] {
    return this.entries[dir] ?? [];
  }

  readPreview(fullPath: string): PreviewData {
    return (
      this.previews[fullPath] ?? {
        rawText: "first\nsecond",
        fallbackLines: ["first", "second"],
        highlight: true,
      }
    );
  }

  renderPreviewLines(_fullPath: string, preview: PreviewData): string[] {
    if (!preview.rawText) return preview.fallbackLines;
    return preview.rawText.split("\n").map((line) => `hl:${line}`);
  }

  readEditableText(): { kind: "text"; text: string } {
    return { kind: "text", text: "" };
  }

  writeText(): void {}

  displayPath(fullPath: string): string {
    return fullPath;
  }
}

function entry(fullPath: string, isDirectory: boolean): TreeEntry {
  return {
    name: fullPath.split("/").at(-1) ?? fullPath,
    fullPath,
    isDirectory,
  };
}

describe("FileTreeModel", () => {
  it("expands and collapses directories", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      "/root/src": [entry("/root/src/index.ts", false)],
    });

    const tree = new FileTreeModel("/root", files);

    expect(tree.rows.map((row) => row.label)).toEqual(["▸ src/", "README.md"]);

    expect(tree.toggleDirectorySelected()).toBe(true);
    expect(tree.rows.map((row) => row.label)).toEqual([
      "▾ src/",
      "  index.ts",
      "README.md",
    ]);

    expect(tree.toggleDirectorySelected()).toBe(true);
    expect(tree.rows.map((row) => row.label)).toEqual(["▸ src/", "README.md"]);
  });

  it("reroots into expanded directories and can climb back out", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      "/root/src": [entry("/root/src/index.ts", false)],
    });

    const tree = new FileTreeModel("/root", files);
    let reroots = 0;

    tree.expandSelected(() => {
      reroots += 1;
    });
    expect(tree.treeRoot).toBe("/root");
    expect(reroots).toBe(0);

    tree.expandSelected(() => {
      reroots += 1;
    });
    expect(tree.treeRoot).toBe("/root/src");
    expect(reroots).toBe(1);
    expect(tree.rows.map((row) => row.label)).toEqual(["index.ts"]);

    tree.collapseSelected(() => {
      reroots += 1;
    });
    expect(tree.treeRoot).toBe("/root");
    expect(reroots).toBe(2);
    expect(tree.currentRow()?.fullPath).toBe("/root/src");
  });

  it("keeps the selection visible while scrolling", () => {
    const files = new FakeFileRepository({
      "/root": [
        entry("/root/a", false),
        entry("/root/b", false),
        entry("/root/c", false),
        entry("/root/d", false),
      ],
    });

    const tree = new FileTreeModel("/root", files);

    tree.move(3);
    tree.keepSelectionVisible(2);
    expect(tree.scroll).toBe(2);

    tree.move(-3);
    tree.keepSelectionVisible(2);
    expect(tree.scroll).toBe(0);
  });
});

describe("PreviewModel", () => {
  it("opens, scrolls, invalidates, and closes previews", () => {
    const preview = {
      rawText: "one\ntwo",
      fallbackLines: ["one", "two"],
      highlight: true,
    } satisfies PreviewData;

    const files = new FakeFileRepository({}, { "/root/file.ts": preview });
    const model = new PreviewModel(files);

    model.open("/root/file.ts");
    expect(model.isOpen()).toBe(true);
    expect(model.previewLines).toEqual(["hl:one", "hl:two"]);

    model.scrollBy(5);
    expect(model.previewScroll).toBe(5);

    model.invalidate();
    expect(model.previewLines).toEqual(["hl:one", "hl:two"]);

    expect(model.close()).toBe(true);
    expect(model.isOpen()).toBe(false);
    expect(model.close()).toBe(false);
  });
});
