import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileSearchModel,
  FileTreeModel,
  FileViewerOverlay,
  PreviewModel,
  type FileViewerState,
} from "../extension/file-browser";
import {
  buildPinManagerItems,
  buildPinnedFileContextText,
  describePinnedFiles,
  ensurePin,
  removeContextPin,
  togglePinnedPin,
  type ContextPin,
} from "../extension/pinned-files";
import {
  FileRepository,
  type PreviewData,
  type TrackedFile,
  type TreeEntry,
} from "../extension/file-repository";

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

  createEntry(): void {}

  moveEntry(): void {}

  deleteEntry(): void {}

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

function tracked(relativePath: string, isDirectory = false): TrackedFile {
  return {
    fullPath: `/root/${relativePath}`,
    relativePath,
    baseName: relativePath.split("/").at(-1) ?? relativePath,
    isDirectory,
  };
}

function filePin(fullPath: string): ContextPin {
  return { kind: "file", fullPath };
}

function rangePin(
  fullPath: string,
  startLine: number,
  endLine: number,
  snapshot: string,
): ContextPin {
  return { kind: "range", fullPath, startLine, endLine, snapshot };
}

function typeIntoOverlay(overlay: FileViewerOverlay, text: string): void {
  for (const char of text) {
    overlay.handleInput(char);
  }
}

const pathDisplayer = {
  displayPath(fullPath: string, cwd: string): string {
    return fullPath.startsWith(`${cwd}/`) ? fullPath.slice(cwd.length + 1) : fullPath;
  },
};

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
        tracked("src", true),
        tracked("src/file-browser.ts"),
        tracked("tests", true),
        tracked("tests/file-browser.test.ts"),
        tracked("README.md"),
      ],
    );

    const search = new FileSearchModel("/root", files);

    search.open();
    expect(search.results.map((result) => result.relativePath)).toEqual([
      "README.md",
      "src",
      "src/file-browser.ts",
      "tests",
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
        tracked("src", true),
        tracked("src/file-browser.ts"),
        tracked("tests", true),
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

  it("reveals directories from search without opening a preview", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true), entry("/root/README.md", false)],
        "/root/src": [entry("/root/src/index.ts", false)],
      },
      {},
      [tracked("src", true), tracked("src/index.ts")],
    );

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

    overlay.handleInput("/");
    overlay.handleInput("s");
    overlay.handleInput("r");
    overlay.handleInput("c");
    overlay.handleInput("\r");

    expect((overlay as any).tree.treeRoot).toBe("/root/src");
    expect((overlay as any).preview.isOpen()).toBe(false);
    expect(overlay.render(40).join("\n")).toContain("index.ts");
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
  it("searches inside the previewed file like vim and shows match status", () => {
    const lines = [
      "zero",
      "beta first",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "beta second",
      "nine",
      "ten",
      "eleven",
    ];
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: lines.join("\n"),
          fallbackLines: lines,
          highlight: true,
        },
      },
    );

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
    overlay.handleInput("/");
    overlay.handleInput("b");
    overlay.handleInput("e");

    expect(overlay.render(80).join("\n")).toContain(" / be");
    expect((overlay as any).preview.cursorLine).toBe(1);

    overlay.handleInput("\r");
    expect(overlay.render(80).join("\n")).toContain(" be 1/2");
    expect((overlay as any).preview.cursorLine).toBe(1);
    expect((overlay as any).preview.previewScroll).toBe(0);

    overlay.handleInput("n");
    overlay.render(80);
    expect(overlay.render(80).join("\n")).toContain(" be 2/2");
    expect((overlay as any).preview.cursorLine).toBe(8);
    expect((overlay as any).preview.previewScroll).toBe(4);

    overlay.handleInput("N");
    expect(overlay.render(80).join("\n")).toContain(" be 1/2");
    expect((overlay as any).preview.cursorLine).toBe(1);
  });

  it("opens stored browser results and jumps to the requested line", () => {
    const lines = ["first", "second", "third"];
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true)],
        "/root/src": [entry("/root/src/file.ts", false)],
      },
      {
        "/root/src/file.ts": {
          rawText: lines.join("\n"),
          fallbackLines: lines,
          highlight: true,
        },
      },
    );
    const results: unknown[] = [];

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
      (result) => results.push(result),
    );

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/file.ts",
        relativePath: "src/file.ts",
        score: 0,
        isDirectory: false,
        startLine: 2,
        endLine: 3,
        reason: "shared guard",
      },
    ]);

    expect(overlay.render(80).join("\n")).toContain("Bug hunt (1)");
    expect(overlay.render(80).join("\n")).toContain("src/file.ts:2-3 │ shared guard");

    overlay.handleInput("\r");

    expect((overlay as any).tree.treeRoot).toBe("/root/src");
    expect((overlay as any).preview.previewPath).toBe("/root/src/file.ts");
    expect((overlay as any).preview.cursorLine).toBe(1);

    overlay.handleInput("q");

    const renderedResults = overlay.render(80).join("\n");
    expect(renderedResults).toContain("Bug hunt (1)");
    expect(renderedResults).toContain("src/file.ts:2-3 │ shared guard");
    expect((overlay as any).preview.previewPath).toBeUndefined();
    expect(results).toEqual([]);
  });

  it("keeps stored result descriptions dim without styling file paths", () => {
    const files = new FakeFileRepository({});

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 10 } } as never,
      {
        fg: (color: string, text: string) => `[${color}:${text}]`,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => `<b>${text}</b>`,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/a.ts",
        relativePath: "src/a.ts",
        score: 0,
        isDirectory: false,
        reason: "shared guard",
      },
    ]);

    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("src/a.ts");
    expect(rendered).not.toContain("<b>src/a.ts</b>");
    expect(rendered).not.toContain("[muted:src/a.ts]");
    expect(rendered).toContain("[muted: │ ]");
    expect(rendered).toContain("[muted:shared guard]");
  });

  it("keeps row background active after ansi resets in truncated search results", () => {
    const files = new FakeFileRepository({});

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 10 } } as never,
      {
        fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[0m`,
        bg: (_color: string, text: string) => `\x1b[43m${text}\x1b[0m`,
        bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
      } as never,
      files,
      [],
      undefined,
      () => {},
      () => {},
    );

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/a.ts",
        relativePath: "src/a.ts",
        score: 0,
        isDirectory: false,
        reason: "This is a very long description that should force truncation and would previously leave a black gap after an ANSI reset.",
      },
    ]);

    const row = overlay.render(80)[1] ?? "";
    expect(row).not.toMatch(/\x1b\[0m +\x1b\[0m$/);
  });

  it("navigates stored browser results with j/k before entering filter mode", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true)],
        "/root/src": [entry("/root/src/a.ts", false), entry("/root/src/b.ts", false)],
      },
      {
        "/root/src/a.ts": {
          rawText: "first",
          fallbackLines: ["first"],
          highlight: true,
        },
        "/root/src/b.ts": {
          rawText: "second",
          fallbackLines: ["second"],
          highlight: true,
        },
      },
    );

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

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/a.ts",
        relativePath: "src/a.ts",
        score: 0,
        isDirectory: false,
      },
      {
        fullPath: "/root/src/b.ts",
        relativePath: "src/b.ts",
        score: 0,
        isDirectory: false,
      },
    ]);

    expect(overlay.render(80).join("\n")).toContain("Bug hunt (2)");

    overlay.handleInput("j");
    overlay.handleInput("\r");

    expect((overlay as any).preview.previewPath).toBe("/root/src/b.ts");
  });

  it("closes stored browser results with q instead of starting a filter", () => {
    const files = new FakeFileRepository({});
    const results: unknown[] = [];

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
      (result) => results.push(result),
    );

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/README.md",
        relativePath: "README.md",
        score: 0,
        isDirectory: false,
      },
    ]);

    overlay.handleInput("q");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "close" });
  });

  it("uses q to step back from tracked search to the tree", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true), entry("/root/README.md", false)],
      },
      {},
      [tracked("src", true), tracked("README.md")],
    );
    const results: unknown[] = [];

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
      (result) => results.push(result),
    );

    overlay.handleInput("/");
    expect((overlay as any).activeScreen()).toBe("search");

    overlay.handleInput("q");

    expect((overlay as any).activeScreen()).toBe("tree");
    expect(overlay.render(80).join("\n")).toContain("README.md");
    expect(results).toEqual([]);
  });

  it("uses o to reopen a search-result preview in the tree view", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true)],
        "/root/src": [entry("/root/src/file.ts", false)],
      },
      {
        "/root/src/file.ts": {
          rawText: "first\nsecond",
          fallbackLines: ["first", "second"],
          highlight: true,
        },
      },
    );

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

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/file.ts",
        relativePath: "src/file.ts",
        score: 0,
        isDirectory: false,
      },
    ]);
    overlay.handleInput("\r");

    expect((overlay as any).leftPanelScreen()).toBe("search");
    overlay.handleInput("o");

    expect((overlay as any).activeScreen()).toBe("preview");
    expect((overlay as any).leftPanelScreen()).toBe("tree");
    expect((overlay as any).tree.treeRoot).toBe("/root/src");
    expect((overlay as any).tree.currentRow()?.fullPath).toBe("/root/src/file.ts");
  });

  it("uses y to copy the previewed file without closing the overlay", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "alpha\nbeta",
          fallbackLines: ["alpha", "beta"],
          highlight: true,
        },
      },
    );
    const copied: string[] = [];
    const results: unknown[] = [];

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
      (result) => {
        results.push(result);
      },
      (fullPath: string) => {
        copied.push(fullPath);
      },
    );

    overlay.handleInput("\r");
    overlay.handleInput("y");

    expect(copied).toEqual(["/root/file.ts"]);
    expect((overlay as any).preview.isOpen()).toBe(true);
    expect(results).toEqual([]);
  });

  it("uses ctrl+c to dismiss preview search status without closing the overlay", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "alpha\nbeta\ngamma",
          fallbackLines: ["alpha", "beta", "gamma"],
          highlight: true,
        },
      },
    );
    const results: unknown[] = [];

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
      (result) => {
        results.push(result);
      },
    );

    overlay.handleInput("\r");
    overlay.handleInput("/");
    overlay.handleInput("b");
    overlay.handleInput("\r");
    overlay.handleInput(String.fromCharCode(3));

    expect((overlay as any).preview.isOpen()).toBe(true);
    expect(overlay.render(80).join("\n")).not.toContain(" b 1/1");
    expect(results).toEqual([]);
  });

  it("does not close the overlay with ctrl+c outside transient modes", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/file.ts", false)],
    });
    const results: unknown[] = [];

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
      () => {},
      (result) => {
        results.push(result);
      },
    );

    overlay.handleInput(String.fromCharCode(3));
    expect(results).toEqual([]);

    overlay.handleInput("\r");
    overlay.handleInput(String.fromCharCode(3));
    expect((overlay as any).preview.isOpen()).toBe(true);
    expect(results).toEqual([]);
  });

  it("uses ctrl+c to dismiss preview selection without closing the overlay", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );
    const results: unknown[] = [];

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
      () => {},
      (result) => {
        results.push(result);
      },
    );

    overlay.handleInput("\r");
    overlay.handleInput("j");
    overlay.handleInput("v");
    overlay.handleInput("j");
    overlay.handleInput(String.fromCharCode(3));

    expect((overlay as any).preview.selectionAnchor).toBeUndefined();
    expect((overlay as any).preview.isOpen()).toBe(true);
    expect(results).toEqual([]);
  });

  it("clears preview selection after toggling a preview range", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );

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
      () => {},
      () => {},
    );

    overlay.handleInput("\r");
    overlay.handleInput("j");
    overlay.handleInput("v");
    overlay.handleInput("j");
    overlay.handleInput("s");
    overlay.handleInput("v");

    const rendered = overlay.render(80).join("\n");
    expect(rendered).not.toContain("> 2 | hl:second");
    expect(rendered).not.toContain("● 2 | hl:second");
    expect(rendered).not.toContain("● 3 | hl:third");
  });

  it("shows the pinned marker immediately after toggling a preview range", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );

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
      () => {},
      () => {},
    );

    overlay.handleInput("\r");
    overlay.handleInput("j");
    overlay.handleInput("v");
    overlay.handleInput("j");
    overlay.handleInput("s");

    const rendered = overlay.render(80).join("\n");
    expect(rendered).toContain("● 2 | hl:second");
    expect(rendered).toContain("● 3 | hl:third");
  });

  it("removes the pinned preview range with v on the hunk", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );
    const committed: ContextPin[][] = [];

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 20 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [rangePin("/root/file.ts", 2, 3, "second\nthird")],
      (pins: ContextPin[]) => {
        committed.push(pins);
      },
      () => {},
    );

    overlay.handleInput("\r");
    overlay.handleInput("v");
    const rendered = overlay.render(80).join("\n");

    expect(rendered).not.toContain("● 2 | hl:second");
    expect(rendered).not.toContain("● 3 | hl:third");

    overlay.handleInput("q");
    overlay.handleInput("q");
    expect(committed).toEqual([[]]);
  });

  it("restores the last tree and preview state when reopened", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true), entry("/root/README.md", false)],
        "/root/src": [entry("/root/src/a.ts", false), entry("/root/src/b.ts", false)],
      },
      {
        "/root/src/b.ts": {
          rawText: "one\ntwo\nthree",
          fallbackLines: ["one", "two", "three"],
          highlight: true,
        },
      },
    );
    const results: { state: FileViewerState }[] = [];

    const first = new FileViewerOverlay(
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
      (result) => {
        results.push(result as { state: FileViewerState });
      },
    );

    first.handleInput("\r");
    first.handleInput("j");
    first.handleInput("\r");
    first.handleInput("j");
    first.handleInput("j");
    first.handleInput("q");
    first.handleInput("q");

    const second = new FileViewerOverlay(
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

    second.restoreState(results[0]?.state);

    expect((second as any).tree.treeRoot).toBe("/root/src");
    expect((second as any).tree.currentRow()?.fullPath).toBe("/root/src/b.ts");
    expect((second as any).preview.previewPath).toBeUndefined();
  });

  it("shows the pinned preview range again when reopening the file", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );

    const overlay = new FileViewerOverlay(
      "/root",
      { requestRender() {}, terminal: { rows: 20 } } as never,
      {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as never,
      files,
      [rangePin("/root/file.ts", 2, 3, "second\nthird")],
      undefined,
      () => {},
      () => {},
    );

    overlay.handleInput("\r");
    const rendered = overlay.render(80).join("\n");

    expect(rendered).toContain("● 2 | hl:second");
    expect(rendered).toContain("● 3 | hl:third");
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

  it("creates files and directories from the tree", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-overlay-"));

    try {
      const overlay = new FileViewerOverlay(
        root,
        { requestRender() {}, terminal: { rows: 10 } } as never,
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as never,
        new FileRepository((code) => code.split("\n")),
        [],
        undefined,
        () => {},
        () => {},
      );

      overlay.handleInput("a");
      expect(overlay.render(80)[0]).toContain("a ./");
      typeIntoOverlay(overlay, "notes.ts");
      overlay.handleInput("\r");

      overlay.handleInput("a");
      typeIntoOverlay(overlay, "empty/");
      overlay.handleInput("\r");

      expect(overlay.render(80).join("\n")).toContain("notes.ts");
      expect(overlay.render(80).join("\n")).toContain("empty/");
      expect(existsSync(path.join(root, "notes.ts"))).toBe(true);
      expect(existsSync(path.join(root, "empty"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renames or moves the selected file and keeps pins pointed at it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-overlay-"));
    const committed: ContextPin[][] = [];

    try {
      mkdirSync(path.join(root, "src"));
      writeFileSync(path.join(root, "todo.ts"), "export const todo = true;\n");

      const overlay = new FileViewerOverlay(
        root,
        { requestRender() {}, terminal: { rows: 10 } } as never,
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as never,
        new FileRepository((code) => code.split("\n")),
        [filePin(path.join(root, "todo.ts"))],
        undefined,
        (pins: ContextPin[]) => {
          committed.push(pins);
        },
        () => {},
      );

      overlay.handleInput("j");
      overlay.handleInput("m");
      expect(overlay.render(80)[0]).toContain("m ./todo.ts");
      (overlay as any).treeAction = {
        ...(overlay as any).treeAction,
        input: "",
      };
      typeIntoOverlay(overlay, "src/done.ts");
      overlay.handleInput("\r");
      overlay.handleInput("q");

      expect(existsSync(path.join(root, "todo.ts"))).toBe(false);
      expect(existsSync(path.join(root, "src", "done.ts"))).toBe(true);
      expect(committed).toEqual([[filePin(path.join(root, "src", "done.ts"))]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes only after confirmation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-files-overlay-"));

    try {
      writeFileSync(path.join(root, "drop.ts"), "export const drop = true;\n");

      const overlay = new FileViewerOverlay(
        root,
        { requestRender() {}, terminal: { rows: 10 } } as never,
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as never,
        new FileRepository((code) => code.split("\n")),
        [],
        undefined,
        () => {},
        () => {},
      );

      overlay.handleInput("d");
      overlay.handleInput("n");
      expect(existsSync(path.join(root, "drop.ts"))).toBe(true);

      overlay.handleInput("d");
      overlay.handleInput("y");
      expect(existsSync(path.join(root, "drop.ts"))).toBe(false);
      expect(overlay.render(80).join("\n")).not.toContain("drop.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("toggles multiple next-turn pins with ctrl+s and s", () => {
    const files = new FakeFileRepository({
      "/root": [entry("/root/a.ts", false), entry("/root/b.ts", false)],
    });
    const committed: ContextPin[][] = [];

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
      (paths: ContextPin[]) => {
        committed.push(paths);
      },
      () => {},
    );

    overlay.handleInput(String.fromCharCode(19));
    overlay.handleInput("j");
    overlay.handleInput("s");
    const renderedPinned = overlay.render(80).join("\n");
    expect(renderedPinned).toContain("a.ts ●");
    expect(renderedPinned).toContain("b.ts ●");

    overlay.handleInput("q");
    expect(committed).toEqual([[filePin("/root/a.ts"), filePin("/root/b.ts")]]);
  });

  it("uses ctrl+s in preview to pin the whole file instead of a hunk", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/file.ts", false)],
      },
      {
        "/root/file.ts": {
          rawText: "first\nsecond\nthird",
          fallbackLines: ["first", "second", "third"],
          highlight: true,
        },
      },
    );
    const committed: ContextPin[][] = [];

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
      (pins: ContextPin[]) => {
        committed.push(pins);
      },
      () => {},
    );

    overlay.handleInput("\r");
    overlay.handleInput("j");
    overlay.handleInput("v");
    overlay.handleInput("j");
    overlay.handleInput(String.fromCharCode(19));
    overlay.handleInput("q");
    overlay.handleInput("q");

    expect(committed).toEqual([[filePin("/root/file.ts")]]);
  });

  it("sizes the tree pane from the available width", () => {
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

    expect((overlay as any).leftPanelWidth(78, 1, "tree")).toBe(25);
    expect((overlay as any).leftPanelWidth(58, 1, "tree")).toBe(25);
    expect((overlay as any).leftPanelWidth(98, 1, "tree")).toBe(25);
    expect((overlay as any).leftPanelWidth(158, 1, "tree")).toBe(39);
    expect((overlay as any).leftPanelWidth(78, 1, "search")).toBe(38);
    expect((overlay as any).leftPanelWidth(58, 1, "search")).toBe(28);
  });

  it("caps the tree pane width at 50 columns", () => {
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

    expect((overlay as any).leftPanelWidth(1000, 1, "tree")).toBe(50);
    expect((overlay as any).leftPanelWidth(1000, 1, "search")).toBe(499);
  });

  it("falls back to a full-width tree when the split cannot keep the minimum tree width", () => {
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

    expect(overlay.render(32).join("\n")).toContain("very-long-file-name.ts");
  });

  it("keeps the tree pane width when preview opens", () => {
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

    const treePaneWidth = (overlay as any).leftPanelWidth(78, 1, "tree");
    const before = overlay.render(80);
    overlay.handleInput("\r");
    const after = overlay.render(80);

    expect(before[0]).toContain("q close • ? help");
    expect(before.join("\n")).toContain("very-long-file-name");
    expect(before.join("\n")).not.toContain("Ctrl+C: close");
    expect(before).toHaveLength(10);
    expect(treePaneWidth).toBeLessThan((overlay as any).leftPanelWidth(78, 1, "search"));
    expect(before[1]?.slice(0, treePaneWidth)).toBe(after[1]?.slice(0, treePaneWidth));
  });

  it("shows stored search results as a plain list before preview opens", () => {
    const files = new FakeFileRepository(
      {
        "/root": [entry("/root/src", true)],
        "/root/src": [entry("/root/src/very-long-file-name.ts", false)],
      },
      {
        "/root/src/very-long-file-name.ts": {
          rawText: "first\nsecond",
          fallbackLines: ["first", "second"],
          highlight: true,
        },
      },
    );

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

    overlay.openResults("Bug hunt", [
      {
        fullPath: "/root/src/very-long-file-name.ts",
        relativePath: "src/very-long-file-name.ts",
        score: 0,
        isDirectory: false,
        reason: "search result",
      },
    ]);

    const beforeLines = overlay.render(80);
    const before = beforeLines.join("\n");
    expect(before).toContain("src/very-long-file-name.ts");
    expect(before).toContain("search result");
    expect(before).not.toContain("Description");

    overlay.handleInput("\r");
    const after = overlay.render(80);
    expect(after).toHaveLength(10);

    const treePaneWidth = (overlay as any).leftPanelWidth(78, 1, "search");
    const stripAnsi = (line: string | undefined) => (line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
    const beforeLine = stripAnsi(beforeLines[1]);
    const afterLine = stripAnsi(after[1]);
    expect(beforeLine).toContain("src/very-long-file-name.ts │ search result");
    expect(beforeLine.length).toBeGreaterThan(afterLine.length);
    expect(beforeLine.slice(0, treePaneWidth)).toBe(afterLine.slice(0, treePaneWidth));
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
    expect(firstPage.join("\n")).toContain("Navigation");

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

describe("file pin helpers", () => {
  it("normalizes next-turn pins once while preserving display labels", () => {
    expect(
      describePinnedFiles(
        "/root",
        [filePin("/root/file.ts"), filePin("/root/other.ts")],
        pathDisplayer,
      ),
    ).toEqual({
      nextTurn: [
        {
          key: "file:/root/file.ts",
          pin: filePin("/root/file.ts"),
          displayPath: "file.ts",
          displayLabel: "file.ts",
        },
        {
          key: "file:/root/other.ts",
          pin: filePin("/root/other.ts"),
          displayPath: "other.ts",
          displayLabel: "other.ts",
        },
      ],
    });
  });

  it("adds, removes, and toggles next-turn pins without duplicates", () => {
    expect(ensurePin([filePin("/root/a.ts")], filePin("/root/a.ts"))).toEqual([
      filePin("/root/a.ts"),
    ]);
    expect(togglePinnedPin([], filePin("/root/a.ts"))).toEqual([filePin("/root/a.ts")]);
    expect(togglePinnedPin([filePin("/root/a.ts")], filePin("/root/a.ts"))).toEqual([]);
    expect(
      removeContextPin([filePin("/root/a.ts"), filePin("/root/b.ts")], filePin("/root/a.ts")),
    ).toEqual([filePin("/root/b.ts")]);
  });

  it("lists multiple next-turn files in the prompt text", () => {
    const text = buildPinnedFileContextText(
      "/root",
      [filePin("/root/a.ts"), filePin("/root/b.ts")],
      pathDisplayer,
    );

    expect(text).toContain("- next turn file: a.ts");
    expect(text).toContain("- next turn file: b.ts");
  });

  it("embeds snippet pins directly in the prompt text", () => {
    const text = buildPinnedFileContextText(
      "/root",
      [rangePin("/root/a.ts", 2, 3, "two\nthree")],
      pathDisplayer,
    );

    expect(text).toContain("- next turn snippet: a.ts:2-3");
    expect(text).toContain("2 | two");
    expect(text).toContain("3 | three");
  });

  it("builds pin manager items for direct removal", () => {
    expect(
      buildPinManagerItems(
        "/root",
        [filePin("/root/a.ts"), rangePin("/root/b.ts", 4, 5, "x\ny")],
        pathDisplayer,
      ),
    ).toEqual([
      {
        id: "next-turn:file:/root/a.ts",
        label: "a.ts",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
      {
        id: "next-turn:range:/root/b.ts:4:5",
        label: "b.ts:4-5",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
    ]);
  });

  it("deduplicates repeated pins in the pin manager", () => {
    expect(
      buildPinManagerItems(
        "/root",
        [filePin("/root/file.ts"), filePin("/root/file.ts")],
        pathDisplayer,
      ),
    ).toEqual([
      {
        id: "next-turn:file:/root/file.ts",
        label: "file.ts",
        currentValue: "keep",
        values: ["keep", "remove"],
      },
    ]);
  });
});
