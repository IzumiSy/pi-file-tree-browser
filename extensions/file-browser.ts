import path from "node:path";

import { type Theme } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";

import { type FileRepository, fit, type PreviewData } from "./file-repository";

export type TreeRow = {
  fullPath: string;
  label: string;
  isDirectory: boolean;
  depth: number;
  isExpanded: boolean;
};

type BgColor = "selectedBg" | "customMessageBg" | "toolPendingBg";

export type FileViewerResult =
  | { kind: "close" }
  | { kind: "edit"; fullPath: string };

const FILE_SELECTION_BG: BgColor = "selectedBg";
const FILE_TREE_BG: BgColor = "customMessageBg";
const PREVIEW_BG: BgColor = "toolPendingBg";

export class FileTreeModel {
  treeRoot: string;
  rows: TreeRow[] = [];
  selected = 0;
  scroll = 0;
  version = 0;
  readonly expandedPaths = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly files: FileRepository,
  ) {
    this.treeRoot = cwd;
    this.expandedPaths.add(cwd);
    this.reload();
  }

  currentRow(): TreeRow | undefined {
    return this.rows[this.selected];
  }

  move(delta: number): void {
    const next = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
    if (next === this.selected) return;
    this.selected = next;
    this.version += 1;
  }

  reload(selectedPath = this.currentRow()?.fullPath ?? this.treeRoot): void {
    this.rows = buildTreeRows(this.treeRoot, this.expandedPaths, this.files);
    this.selected = findRowIndex(this.rows, selectedPath);
    this.scroll = Math.min(this.scroll, Math.max(0, this.rows.length - 1));
    this.version += 1;
  }

  expandSelected(onReroot: () => void): void {
    const row = this.currentRow();
    if (!row?.isDirectory) return;

    if (row.isExpanded) {
      this.treeRoot = row.fullPath;
      onReroot();
      this.reload();
      return;
    }

    this.expandedPaths.add(row.fullPath);
    this.reload();
  }

  toggleDirectorySelected(): boolean {
    const row = this.currentRow();
    if (!row?.isDirectory) return false;

    if (row.isExpanded) {
      this.expandedPaths.delete(row.fullPath);
    } else {
      this.expandedPaths.add(row.fullPath);
    }
    this.reload();
    return true;
  }

  collapseSelected(onReroot: () => void): void {
    const row = this.currentRow();
    if (!row) return;

    if (row.isDirectory && row.isExpanded) {
      this.expandedPaths.delete(row.fullPath);
      this.reload();
      return;
    }

    const parentPath = path.dirname(row.fullPath);
    const parentIndex = this.rows.findIndex(
      (candidate) => candidate.fullPath === parentPath,
    );
    if (parentIndex !== -1) {
      if (this.selected !== parentIndex) {
        this.selected = parentIndex;
        this.version += 1;
      }
      return;
    }

    if (this.treeRoot !== this.cwd) {
      const previousRoot = this.treeRoot;
      this.treeRoot = path.dirname(this.treeRoot);
      onReroot();
      this.reload(previousRoot);
    }
  }

  keepSelectionVisible(bodyHeight: number): void {
    const previous = this.scroll;
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + bodyHeight) {
      this.scroll = this.selected - bodyHeight + 1;
    }
    this.scroll = Math.max(0, this.scroll);
    if (this.scroll !== previous) this.version += 1;
  }
}

type RenderCache = {
  key: string;
  lines: string[];
};

function getCachedLines(
  cache: RenderCache | undefined,
  key: string,
  build: () => string[],
): RenderCache {
  if (cache?.key === key) return cache;
  return { key, lines: build() };
}

export class PreviewModel {
  previewPath: string | undefined;
  previewData: PreviewData | undefined;
  previewScroll = 0;
  previewPageStep = 1;

  constructor(private readonly files: FileRepository) {}

  isOpen(): boolean {
    return !!this.previewPath && !!this.previewData;
  }

  open(fullPath: string): void {
    this.previewPath = fullPath;
    this.previewData = this.files.readPreview(fullPath);
    this.previewScroll = 0;
  }

  close(): boolean {
    if (!this.previewPath || !this.previewData) return false;
    this.previewPath = undefined;
    this.previewData = undefined;
    this.previewScroll = 0;
    this.previewPageStep = 1;
    return true;
  }

  scrollBy(delta: number): void {
    if (!this.previewData?.fallbackLines.length) return;
    this.previewScroll = Math.max(0, this.previewScroll + delta);
  }

  visibleLines(count: number): string[] {
    if (!this.previewPath || !this.previewData) return [];
    return this.files.renderPreviewLines(
      this.previewPath,
      this.previewData,
      this.previewScroll,
      count,
    );
  }

  lineCount(): number {
    return this.previewData?.fallbackLines.length ?? 0;
  }

  invalidate(): void {}
}

export class FileViewerOverlay {
  private readonly tree: FileTreeModel;
  private readonly preview: PreviewModel;
  private headerCache: RenderCache | undefined;
  private footerCache: RenderCache | undefined;
  private treePanelCache: RenderCache | undefined;

  constructor(
    cwd: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    files: FileRepository,
    private chatContextPath: string | undefined,
    private readonly commitChatContextPath: (fullPath: string | undefined) => void,
    private readonly done: (result: FileViewerResult) => void,
  ) {
    this.tree = new FileTreeModel(cwd, files);
    this.preview = new PreviewModel(files);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.finish();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      if (this.preview.close()) {
        this.tui.requestRender();
        return;
      }
      this.finish();
      return;
    }

    if (matchesKey(data, "up")) {
      this.tree.move(-1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      this.tree.move(1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "k")) {
      if (this.preview.isOpen()) {
        this.preview.scrollBy(-1);
      } else {
        this.tree.move(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "j")) {
      if (this.preview.isOpen()) {
        this.preview.scrollBy(1);
      } else {
        this.tree.move(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      if (this.preview.isOpen()) {
        this.preview.scrollBy(-this.preview.previewPageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.preview.isOpen()) {
        this.preview.scrollBy(this.preview.previewPageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      const row = this.tree.currentRow();
      if (row?.isDirectory) {
        this.tree.expandSelected(() => {
          this.preview.close();
        });
      } else {
        this.openSelected();
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      if (this.preview.close()) {
        this.tui.requestRender();
        return;
      }
      this.tree.collapseSelected(() => {
        this.preview.close();
      });
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.preview.previewPath) {
        this.editPreviewedFile();
        return;
      }
      this.openSelected();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "s")) {
      this.toggleSelectedContextPath();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "r")) {
      this.tree.reload();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const terminalHeight = Math.max(1, this.tui.terminal.rows);
    const bodyRows = Math.max(1, terminalHeight - 3);

    this.tree.keepSelectionVisible(bodyRows);

    const paddingX = width > 2 ? 1 : 0;
    const contentWidth = Math.max(1, width - paddingX * 2);
    const lines = [...this.renderHeader(width, paddingX, contentWidth)];

    if (!this.preview.isOpen()) {
      if (width < 24) {
        lines.push(...this.renderTreePanel(contentWidth, bodyRows, paddingX));
      } else {
        const gutterWidth = 1;
        const leftWidth = Math.max(
          10,
          Math.floor((contentWidth - gutterWidth) * 0.15),
        );
        const rightWidth = Math.max(10, contentWidth - gutterWidth - leftWidth);
        const leftLines = this.renderTreePanel(leftWidth, bodyRows, 0);
        const rightLines = Array.from({ length: leftLines.length }, () =>
          " ".repeat(rightWidth),
        );
        lines.push(...this.joinColumns(leftLines, rightLines, gutterWidth));
      }
    } else if (width < 24) {
      lines.push(...this.renderTreePanel(contentWidth, Math.max(1, bodyRows - 5), paddingX));
      lines.push(...this.renderPreviewPanel(contentWidth, 5));
    } else {
      const gutterWidth = 1;
      const leftWidth = Math.max(10, Math.floor((contentWidth - gutterWidth) * 0.15));
      const rightWidth = Math.max(10, contentWidth - gutterWidth - leftWidth);
      const leftLines = this.renderTreePanel(leftWidth, bodyRows, 0);
      const rightLines = this.renderPreviewPanel(rightWidth, bodyRows);
      lines.push(...this.joinColumns(leftLines, rightLines, gutterWidth));
    }

    lines.push(...this.renderFooter(width, paddingX, contentWidth));
    return lines;
  }

  invalidate(): void {
    this.headerCache = undefined;
    this.footerCache = undefined;
    this.treePanelCache = undefined;
    this.preview.invalidate();
  }

  dispose(): void {}

  private finish(result: FileViewerResult = { kind: "close" }): void {
    this.commitChatContextPath(this.chatContextPath);
    this.done(result);
  }

  private openSelected(): void {
    const row = this.tree.currentRow();
    if (!row || row.fullPath.endsWith("#more")) return;

    if (row.isDirectory) {
      this.tree.toggleDirectorySelected();
      return;
    }

    this.preview.open(row.fullPath);
  }

  private editPreviewedFile(): void {
    if (!this.preview.previewPath) return;
    this.finish({ kind: "edit", fullPath: this.preview.previewPath });
  }

  private toggleSelectedContextPath(): void {
    const row = this.tree.currentRow();
    if (!row || row.isDirectory || row.fullPath.endsWith("#more")) return;

    this.chatContextPath =
      this.chatContextPath === row.fullPath ? undefined : row.fullPath;
  }

  private boxFromLines(
    lines: string[],
    paddingX: number,
    width: number,
    bg?: BgColor,
  ): Box {
    const box = bg
      ? new Box(paddingX, 0, (text) => this.theme.bg(bg, text))
      : new Box(paddingX, 0);
    box.addChild(new Text(lines.map((line) => fit(width, line)).join("\n"), 0, 0));
    return box;
  }

  private renderTreeLine(
    row: TreeRow | undefined,
    width: number,
    selected: boolean,
  ): string {
    if (!row) return this.theme.bg(FILE_TREE_BG, " ".repeat(width));
    const marker =
      !row.isDirectory && this.chatContextPath === row.fullPath
        ? this.theme.fg("warning", " ●")
        : "";
    const content = row.isDirectory
      ? this.theme.fg("accent", row.label)
      : `${row.label}${marker}`;
    const line = fit(width, selected ? this.theme.bold(content) : content);
    return this.theme.bg(selected ? FILE_SELECTION_BG : FILE_TREE_BG, line);
  }

  private renderHeader(width: number, paddingX: number, contentWidth: number): string[] {
    const key = `${width}:${paddingX}:${contentWidth}:${this.tree.treeRoot}`;
    this.headerCache = getCachedLines(this.headerCache, key, () =>
      this.boxFromLines(
        [this.theme.fg("muted", ` ${this.tree.treeRoot}`)],
        paddingX,
        contentWidth,
        "selectedBg",
      ).render(width),
    );
    return this.headerCache.lines;
  }

  private renderFooter(width: number, paddingX: number, contentWidth: number): string[] {
    const key = `${width}:${paddingX}:${contentWidth}`;
    this.footerCache = getCachedLines(this.footerCache, key, () =>
      this.boxFromLines(
        [
          this.theme.fg(
            "text",
            " ↑↓: move  •  j/k: move or preview scroll  •  Ctrl+U/D: preview page scroll  •  s: pin/unpin next-turn ctx  •  h/l/q/Esc: close preview or fold/unfold  •  Enter: preview, then edit  •  r: reload  •  Ctrl+C: close ",
          ),
        ],
        paddingX,
        contentWidth,
        "customMessageBg",
      ).render(width),
    );
    return this.footerCache.lines;
  }

  private renderTreePanel(width: number, height: number, paddingX: number): string[] {
    const key = [
      width,
      height,
      paddingX,
      this.tree.version,
      this.tree.scroll,
      this.tree.selected,
      this.chatContextPath ?? "",
    ].join(":");
    this.treePanelCache = getCachedLines(this.treePanelCache, key, () => {
      const visibleRows = this.tree.rows.slice(
        this.tree.scroll,
        this.tree.scroll + Math.max(1, height),
      );
      return this.boxFromLines(
        Array.from({ length: Math.max(1, height) }, (_, index) =>
          this.renderTreeLine(
            visibleRows[index],
            width,
            this.tree.scroll + index === this.tree.selected,
          ),
        ),
        paddingX,
        width,
      ).render(width + paddingX * 2);
    });
    return this.treePanelCache.lines;
  }

  private renderPreviewPanel(width: number, height: number): string[] {
    const bodyHeight = Math.max(1, height);
    this.preview.previewPageStep = Math.max(1, Math.floor(bodyHeight / 2));
    const maxScroll = Math.max(0, this.preview.lineCount() - bodyHeight);
    this.preview.previewScroll = Math.min(this.preview.previewScroll, maxScroll);
    const lines = this.preview.visibleLines(bodyHeight);

    return Array.from({ length: bodyHeight }, (_, index) =>
      this.theme.bg(PREVIEW_BG, fit(width, lines[index] ?? "")),
    );
  }

  private joinColumns(
    left: string[],
    right: string[],
    gutterWidth: number,
  ): string[] {
    const lines: string[] = [];
    const gutter = " ".repeat(gutterWidth);
    const count = Math.max(left.length, right.length);

    for (let index = 0; index < count; index++) {
      lines.push(`${left[index] ?? ""}${gutter}${right[index] ?? ""}`);
    }

    return lines;
  }
}

function buildTreeRows(
  root: string,
  expandedPaths: ReadonlySet<string>,
  files: FileRepository,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const entries = files.listEntries(root);
  const shown = entries.slice(0, 40);

  for (const entry of shown) {
    if (entry.isDirectory) {
      visit(entry.fullPath, 0);
    } else {
      rows.push({
        fullPath: entry.fullPath,
        label: entry.name,
        isDirectory: false,
        depth: 0,
        isExpanded: false,
      });
    }
  }

  if (entries.length > shown.length) {
    rows.push({
      fullPath: `${root}#more`,
      label: `… ${entries.length - shown.length} more`,
      isDirectory: false,
      depth: 0,
      isExpanded: false,
    });
  }

  return rows;

  function visit(dir: string, depth: number): void {
    const name = path.basename(dir);
    const isExpanded = expandedPaths.has(dir);

    rows.push({
      fullPath: dir,
      label: `${indent(depth)}${isExpanded ? "▾" : "▸"} ${name}/`,
      isDirectory: true,
      depth,
      isExpanded,
    });

    if (!isExpanded) return;

    const entries = files.listEntries(dir);
    const shown = entries.slice(0, 40);

    for (const entry of shown) {
      if (entry.isDirectory) {
        visit(entry.fullPath, depth + 1);
      } else {
        rows.push({
          fullPath: entry.fullPath,
          label: `${indent(depth + 1)}${entry.name}`,
          isDirectory: false,
          depth: depth + 1,
          isExpanded: false,
        });
      }
    }

    if (entries.length > shown.length) {
      rows.push({
        fullPath: `${dir}#more`,
        label: `${indent(depth + 1)}… ${entries.length - shown.length} more`,
        isDirectory: false,
        depth: depth + 1,
        isExpanded: false,
      });
    }
  }
}

function findRowIndex(rows: TreeRow[], fullPath: string): number {
  const exact = rows.findIndex((row) => row.fullPath === fullPath);
  if (exact !== -1) return exact;

  let current = fullPath;
  while (current !== path.dirname(current)) {
    current = path.dirname(current);
    const index = rows.findIndex((row) => row.fullPath === current);
    if (index !== -1) return index;
  }

  return 0;
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}
