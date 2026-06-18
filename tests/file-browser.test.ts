import { describe, expect, it } from "vitest";
import {
  FileSearchModel,
  FileTreeModel,
  FileViewerOverlay,
  PreviewModel,
} from "../extensions/file-browser";
import {
  buildPinManagerItems,
  buildPinnedFileContextText,
  readSessionContextPath,
} from "../extensions/main";
import type {
  PreviewData,
  TrackedFile,
  TreeEntry,
} from "../extensions/file-repository";

class FakeFileRepository {
  constructor(
    private readonly entries: Record<string, TreeEntry[]>,
    private readonly previews: Record<string, PreviewData> = {},
    private readonly trackedFiles: TrackedFile[] = [],
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

  renderPreviewLines(
    _fullPath: string,
    preview: PreviewData,
    start = 0,
    count = preview.fallbackLines.length,
  ): string[] {
    return preview.fallbackLines
      .slice(start, start + count)
      .map((line) => `hl:${line}`);
  }

  readEditableText(): { kind: "text"; text: string } {
    return { kind: "text", text: "" };
  }

  listTrackedFiles(): TrackedFile[] {
    return this.trackedFiles;
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

function tracked(relativePath: string): TrackedFile {
  return {
    fullPath: `/root/${relativePath}`,
    relativePath,
    baseName: relativePath.split("/").at(-1) ?? relativePath,
  };
}

describe("FileTreeModel", () => {
  it("shows only the current directory entries", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      "/root/src": [entry("/root/src/index.ts", false)],
    });

    const tree = new FileTreeModel("/root", files);

    expect(tree.rows.map((row) => row.label)).toEqual(["src/", "README.md"]);
  });

  it("reroots into directories and can climb back out", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      "/root/src": [entry("/root/src/index.ts", false)],
    });

    const tree = new FileTreeModel("/root", files);
    let reroots = 0;

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

describe("FileSearchModel", () => {
  it("filters git-tracked files incrementally and prefers basename matches", () => {
    const files = new FakeFileRepository(
      {},
      {},
      [
        tracked("src/file-browser.ts"),
        tracked("tests/file-browser.test.ts"),
        tracked("README.md"),
      ],
    );

    const search = new FileSearchModel("/root", files);

    search.open();
    expect(search.results.map((result) => result.relativePath)).toEqual([
      "README.md",
      "src/file-browser.ts",
      "tests/file-browser.test.ts",
    ]);

    search.insert("file-b");
    expect(search.results.map((result) => result.relativePath)).toEqual([
      "src/file-browser.ts",
      "tests/file-browser.test.ts",
    ]);

    search.insert("r");
    expect(search.currentResult()?.relativePath).toBe("src/file-browser.ts");
  });

  it("matches abbreviations and typos", () => {
    const files = new FakeFileRepository(
      {},
      {},
      [
        tracked("src/file-browser.ts"),
        tracked("tests/file-browser.test.ts"),
        tracked("README.md"),
      ],
    );

    const search = new FileSearchModel("/root", files);

    search.open();
    search.insert("fbr");
    expect(search.currentResult()?.relativePath).toBe("src/file-browser.ts");

    search.query = "";
    search.insert("brower");
    expect(search.results.map((result) => result.relativePath)).toEqual([
      "src/file-browser.ts",
      "tests/file-browser.test.ts",
    ]);
  });

  it("keeps the search selection visible while scrolling", () => {
    const files = new FakeFileRepository(
      {},
      {},
      [tracked("a.ts"), tracked("b.ts"), tracked("c.ts"), tracked("d.ts")],
    );

    const search = new FileSearchModel("/root", files);
    search.open();

    search.move(3);
    search.keepSelectionVisible(2);
    expect(search.scroll).toBe(2);

    search.move(-3);
    search.keepSelectionVisible(2);
    expect(search.scroll).toBe(0);
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
    expect(model.visibleLines(2)).toEqual(["hl:one", "hl:two"]);
    expect(model.lineAt(1)).toBe("hl:two");

    model.scrollBy(5);
    expect(model.previewScroll).toBe(5);
    expect(model.visibleLines(2)).toEqual([]);
    expect(model.lineAt(0)).toBe("hl:one");

    model.invalidate();
    expect(model.visibleLines(2)).toEqual([]);

    expect(model.close()).toBe(true);
    expect(model.isOpen()).toBe(false);
    expect(model.close()).toBe(false);
  });
});

describe("FileViewerOverlay", () => {
  it("pins the selected file into the session and closes on ctrl+s", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/file.ts", false)],
    });
    const results: unknown[] = [];

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 20 } } as never,
      {} as never,
      files,
      [],
      undefined,
      () => {},
      (result) => {
        results.push(result);
      },
    );

    overlay.handleInput(String.fromCharCode(19));

    expect(results).toEqual([{ kind: "session-pin", fullPath: "/root/file.ts" }]);
  });

  it("moves by 4 rows with ctrl+u/d in the tree", () => {
    const files = new FakeFileRepository({
      "/root": [
        entry("/root/a.ts", false),
        entry("/root/b.ts", false),
        entry("/root/c.ts", false),
        entry("/root/d.ts", false),
        entry("/root/e.ts", false),
        entry("/root/f.ts", false),
      ],
    });

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 11 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    overlay.render(80);
    overlay.handleInput(String.fromCharCode(4));
    expect((overlay as any).tree.currentRow()?.fullPath).toBe("/root/e.ts");

    overlay.handleInput(String.fromCharCode(21));
    expect((overlay as any).tree.currentRow()?.fullPath).toBe("/root/a.ts");
  });

  it("toggles multiple next-turn pins with s", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/a.ts", false), entry("/root/b.ts", false)],
    });
    const committed: string[][] = [];

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 20 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [],
      undefined,
      (paths) => {
        committed.push(paths);
      },
      () => {},
    );

    overlay.handleInput("s");
    overlay.handleInput("j");
    overlay.handleInput("s");
    const renderedPinned = overlay.render(80).join("\n");
    expect(renderedPinned).toContain("a.ts ●");
    expect(renderedPinned).toContain("b.ts ●");

    overlay.handleInput("q");
    expect(committed).toEqual([["/root/a.ts", "/root/b.ts"]]);
  });

  it("keeps the tree pane in a stable split layout before and after preview opens", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/very-long-file-name.ts", false), entry("/root/b.ts", false)],
    });

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 10 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    const before = overlay.render(80);
    overlay.handleInput("\r");
    const after = overlay.render(80);

    expect(before[0]).toContain("Press ? for help");
    expect(before.join("\n")).toContain("very-long-file-name.ts");
    expect(before.join("\n")).not.toContain("Ctrl+C: close");
    expect(before).toHaveLength(10);
    expect(before[1]?.slice(0, 48)).toBe(after[1]?.slice(0, 48));
  });

  it("reroots into directories from the main list", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      "/root/src": [entry("/root/src/index.ts", false)],
    });

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 10 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    overlay.handleInput("\r");
    expect((overlay as any).tree.treeRoot).toBe("/root/src");
    expect(overlay.render(40).join("\n")).toContain("index.ts");

    overlay.handleInput("h");
    expect((overlay as any).tree.treeRoot).toBe("/root");
  });

  it("opens help in-place without overflowing the viewport and closes it cleanly", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/a.ts", false), entry("/root/b.ts", false)],
    });

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 10 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    overlay.handleInput("?");
    const firstPage = overlay.render(24);
    expect(firstPage.length).toBeLessThanOrEqual(10);
    expect(firstPage.join("\n")).toContain("File browser help");

    overlay.handleInput("j");
    const scrolledPage = overlay.render(24).join("\n");
    expect(scrolledPage).toContain("Navigation");
    expect(scrolledPage).not.toContain("File browser help");

    overlay.handleInput("?");
    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("/root");
    expect(rendered).not.toContain("File browser help");
  });
});

describe("session file pin helpers", () => {
  it("restores the latest session-pinned file", () => {
    expect(
      readSessionContextPath([
        { type: "custom", customType: "files-session-context", data: { fullPath: "/root/a.ts" } },
        { type: "custom", customType: "files-session-context", data: { fullPath: "/root/b.ts" } },
      ]),
    ).toBe("/root/b.ts");

    expect(
      readSessionContextPath([
        { type: "custom", customType: "files-session-context", data: { fullPath: "/root/a.ts" } },
        { type: "custom", customType: "files-session-context", data: { fullPath: undefined } },
      ]),
    ).toBeUndefined();
  });

  it("deduplicates session and next-turn pins in the prompt text", () => {
    expect(
      buildPinnedFileContextText("/root", "/root/file.ts", ["/root/file.ts"]),
    ).toContain("- session + next turn: file.ts");
  });

  it("lists multiple next-turn pins in the prompt text", () => {
    const text = buildPinnedFileContextText("/root", undefined, [
      "/root/a.ts",
      "/root/b.ts",
    ]);

    expect(text).toContain("- next turn: a.ts");
    expect(text).toContain("- next turn: b.ts");
  });

  it("builds pin manager items for direct removal", () => {
    expect(
      buildPinManagerItems("/root", "/root/session.ts", ["/root/a.ts", "/root/b.ts"]),
    ).toEqual([
      {
        id: "next-turn:/root/a.ts",
        label: "a.ts",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
      {
        id: "next-turn:/root/b.ts",
        label: "b.ts",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
      {
        id: "session:/root/session.ts",
        label: "session.ts",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
    ]);
  });
});
