import path from "node:path";

import { type Theme } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";

import {
  type FileRepository,
  fit,
  type PreviewData,
  type TrackedFile,
} from "./file-repository";

type FileRepositoryLike = Pick<
  FileRepository,
  | "listEntries"
  | "readPreview"
  | "renderPreviewLines"
  | "readEditableText"
  | "listTrackedFiles"
  | "writeText"
  | "displayPath"
>;

export type TreeRow = {
  fullPath: string;
  label: string;
  isDirectory: boolean;
  depth: number;
  isExpanded: boolean;
};

export type SearchHit = {
  fullPath: string;
  relativePath: string;
  score: number;
};

type BgColor = "selectedBg" | "customMessageBg" | "toolPendingBg";
type ViewerMode = "tree" | "search";

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
    private readonly files: FileRepositoryLike,
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

export class FileSearchModel {
  query = "";
  results: SearchHit[] = [];
  selected = 0;
  scroll = 0;
  version = 0;
  active = false;
  private trackedFiles: TrackedFile[] = [];

  constructor(
    private readonly cwd: string,
    private readonly files: FileRepositoryLike,
  ) {}

  currentResult(): SearchHit | undefined {
    return this.results[this.selected];
  }

  open(): void {
    this.active = true;
    this.query = "";
    this.selected = 0;
    this.scroll = 0;
    this.refresh();
  }

  close(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.query = "";
    this.results = [];
    this.selected = 0;
    this.scroll = 0;
    this.version += 1;
    return true;
  }

  refresh(force = false): void {
    this.trackedFiles = this.files.listTrackedFiles(this.cwd, force);
    this.recompute();
  }

  move(delta: number): void {
    const next = Math.max(0, Math.min(this.results.length - 1, this.selected + delta));
    if (next === this.selected) return;
    this.selected = next;
    this.version += 1;
  }

  insert(text: string): void {
    this.query += text;
    this.recompute();
  }

  backspace(): void {
    if (this.query.length === 0) return;
    this.query = this.query.slice(0, -1);
    this.recompute();
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

  private recompute(selectedPath = this.currentResult()?.fullPath): void {
    const query = this.query.trim().toLowerCase();
    this.results = this.trackedFiles
      .map((file) => {
        const score = scoreTrackedFile(file, query);
        if (score === undefined) return undefined;
        return {
          fullPath: file.fullPath,
          relativePath: file.relativePath,
          score,
        } satisfies SearchHit;
      })
      .filter((hit): hit is SearchHit => !!hit)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.relativePath.length - b.relativePath.length ||
          a.relativePath.localeCompare(b.relativePath),
      );

    this.selected = findSearchIndex(this.results, selectedPath);
    this.scroll = Math.min(this.scroll, Math.max(0, this.results.length - 1));
    this.version += 1;
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

  constructor(private readonly files: FileRepositoryLike) {}

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

  lineAt(index: number): string | undefined {
    if (!this.previewPath || !this.previewData || index < 0) return undefined;
    return this.files.renderPreviewLines(
      this.previewPath,
      this.previewData,
      index,
      1,
    )[0];
  }

  lineCount(): number {
    return this.previewData?.fallbackLines.length ?? 0;
  }

  invalidate(): void {}
}

type PreviewViewportCache = {
  path: string;
  width: number;
  height: number;
  scroll: number;
  lines: string[];
};

export class FileViewerOverlay {
  private readonly tree: FileTreeModel;
  private readonly search: FileSearchModel;
  private readonly preview: PreviewModel;
  private mode: ViewerMode = "tree";
  private headerCache: RenderCache | undefined;
  private footerCache: RenderCache | undefined;
  private treePanelCache: RenderCache | undefined;
  private searchPanelCache: RenderCache | undefined;
  private previewPanelCache: PreviewViewportCache | undefined;

  constructor(
    private readonly cwd: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly files: FileRepositoryLike,
    private chatContextPath: string | undefined,
    private readonly commitChatContextPath: (fullPath: string | undefined) => void,
    private readonly done: (result: FileViewerResult) => void,
  ) {
    this.tree = new FileTreeModel(cwd, files);
    this.search = new FileSearchModel(cwd, files);
    this.preview = new PreviewModel(files);
  }

  handleInput(data: string): void {
    if (this.mode === "search" && this.handleSearchInput(data)) return;

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

    if (data === "/") {
      this.openSearch();
      this.tui.requestRender();
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

    if (this.mode === "search") {
      this.search.keepSelectionVisible(bodyRows);
    } else {
      this.tree.keepSelectionVisible(bodyRows);
    }

    const paddingX = width > 2 ? 1 : 0;
    const contentWidth = Math.max(1, width - paddingX * 2);
    const lines = [...this.renderHeader(width, paddingX, contentWidth)];

    if (this.mode === "search") {
      lines.push(...this.renderSearchPanel(contentWidth, bodyRows, paddingX));
      lines.push(...this.renderFooter(width, paddingX, contentWidth));
      return lines;
    }

    if (!this.preview.isOpen()) {
      if (width < 24) {
        lines.push(...this.renderTreePanel(contentWidth, bodyRows, paddingX));
      } else {
        const gutterWidth = 1;
        const leftWidth = this.leftPanelWidth(contentWidth, gutterWidth);
        const rightWidth = Math.max(10, contentWidth - gutterWidth - leftWidth);
        const leftLines = this.renderTreePanel(leftWidth, bodyRows, 0);
        const rightLines = Array.from({ length: leftLines.length }, () => " ".repeat(rightWidth));
        lines.push(...this.joinColumns(leftLines, rightLines, gutterWidth));
      }
    } else if (width < 24) {
      lines.push(...this.renderTreePanel(contentWidth, Math.max(1, bodyRows - 5), paddingX));
      lines.push(...this.renderPreviewPanel(contentWidth, 5));
    } else {
      const gutterWidth = 1;
      const leftWidth = this.leftPanelWidth(contentWidth, gutterWidth);
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
    this.searchPanelCache = undefined;
    this.previewPanelCache = undefined;
    this.preview.invalidate();
  }

  dispose(): void {}

  private finish(result: FileViewerResult = { kind: "close" }): void {
    this.commitChatContextPath(this.chatContextPath);
    this.done(result);
  }

  private handleSearchInput(data: string): boolean {
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      this.closeSearch();
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "up")) {
      this.search.move(-1);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down")) {
      this.search.move(1);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "enter")) {
      this.closeSearch(this.search.currentResult()?.fullPath);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "backspace")) {
      this.search.backspace();
      this.tui.requestRender();
      return true;
    }

    if (isPrintableInput(data)) {
      this.search.insert(data);
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  private openSearch(): void {
    this.mode = "search";
    this.search.open();
    this.preview.close();
  }

  private closeSearch(revealPath?: string): void {
    this.search.close();
    this.mode = "tree";
    this.preview.close();
    if (!revealPath) return;
    this.revealInTree(revealPath);
    this.preview.open(revealPath);
  }

  private revealInTree(fullPath: string): void {
    if (!isWithin(fullPath, this.tree.treeRoot)) {
      this.tree.treeRoot = this.cwd;
    }

    let current = path.dirname(fullPath);
    while (isWithin(current, this.cwd) && current !== path.dirname(current)) {
      this.tree.expandedPaths.add(current);
      if (current === this.tree.treeRoot) break;
      current = path.dirname(current);
    }

    this.tree.reload(fullPath);
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
    const fullPath = this.selectedFilePath();
    if (!fullPath) return;

    this.chatContextPath = this.chatContextPath === fullPath ? undefined : fullPath;
  }

  private selectedFilePath(): string | undefined {
    if (this.mode === "search") return this.search.currentResult()?.fullPath;

    const row = this.tree.currentRow();
    if (!row || row.isDirectory || row.fullPath.endsWith("#more")) return undefined;
    return row.fullPath;
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

  private renderSearchLine(
    hit: SearchHit | undefined,
    width: number,
    selected: boolean,
  ): string {
    if (!hit) return this.theme.bg(FILE_TREE_BG, " ".repeat(width));
    const marker =
      this.chatContextPath === hit.fullPath ? this.theme.fg("warning", " ●") : "";
    const content = `${hit.relativePath}${marker}`;
    const line = fit(width, selected ? this.theme.bold(content) : content);
    return this.theme.bg(selected ? FILE_SELECTION_BG : FILE_TREE_BG, line);
  }

  private renderHeader(width: number, paddingX: number, contentWidth: number): string[] {
    const text = this.mode === "search"
      ? ` / ${this.search.query || ""} (${this.search.results.length})`
      : ` ${this.tree.treeRoot}`;
    const key = `${width}:${paddingX}:${contentWidth}:${this.mode}:${text}`;
    this.headerCache = getCachedLines(this.headerCache, key, () =>
      this.boxFromLines(
        [this.theme.fg("muted", text)],
        paddingX,
        contentWidth,
        "selectedBg",
      ).render(width),
    );
    return this.headerCache.lines;
  }

  private renderFooter(width: number, paddingX: number, contentWidth: number): string[] {
    const text = this.mode === "search"
      ? " Type to filter git-tracked files  •  ↑↓: move  •  Enter: reveal in tree  •  Backspace: delete  •  Esc/Ctrl+C: back "
      : " /: search tracked files  •  ↑↓: move  •  j/k: move or preview scroll  •  Ctrl+U/D: preview page scroll  •  s: pin/unpin next-turn ctx  •  h/l/q/Esc: close preview or fold/unfold  •  Enter: preview, then edit  •  r: reload  •  Ctrl+C: close ";
    const key = `${width}:${paddingX}:${contentWidth}:${this.mode}`;
    this.footerCache = getCachedLines(this.footerCache, key, () =>
      this.boxFromLines(
        [this.theme.fg("text", text)],
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

  private renderSearchPanel(width: number, height: number, paddingX: number): string[] {
    const key = [
      width,
      height,
      paddingX,
      this.search.version,
      this.search.scroll,
      this.search.selected,
      this.chatContextPath ?? "",
    ].join(":");
    this.searchPanelCache = getCachedLines(this.searchPanelCache, key, () => {
      const visibleRows = this.search.results.slice(
        this.search.scroll,
        this.search.scroll + Math.max(1, height),
      );
      return this.boxFromLines(
        Array.from({ length: Math.max(1, height) }, (_, index) =>
          this.renderSearchLine(
            visibleRows[index],
            width,
            this.search.scroll + index === this.search.selected,
          ),
        ),
        paddingX,
        width,
      ).render(width + paddingX * 2);
    });
    return this.searchPanelCache.lines;
  }

  private leftPanelWidth(contentWidth: number, gutterWidth: number): number {
    return Math.max(10, Math.floor((contentWidth - gutterWidth) * 0.15));
  }

  private renderPreviewPanel(width: number, height: number): string[] {
    const bodyHeight = Math.max(1, height);
    this.preview.previewPageStep = Math.max(1, Math.floor(bodyHeight / 2));
    const maxScroll = Math.max(0, this.preview.lineCount() - bodyHeight);
    this.preview.previewScroll = Math.min(this.preview.previewScroll, maxScroll);

    const previewPath = this.preview.previewPath;
    if (!previewPath) {
      return Array.from({ length: bodyHeight }, () => this.renderPreviewLine(width));
    }

    const scroll = this.preview.previewScroll;
    const cached = this.previewPanelCache;
    if (
      cached &&
      cached.path === previewPath &&
      cached.width === width &&
      cached.height === bodyHeight
    ) {
      if (cached.scroll === scroll) return cached.lines;

      if (cached.scroll + 1 === scroll) {
        const lines = cached.lines.slice(1);
        lines.push(this.renderPreviewLine(width, this.preview.lineAt(scroll + bodyHeight - 1)));
        this.previewPanelCache = { path: previewPath, width, height: bodyHeight, scroll, lines };
        return lines;
      }

      if (cached.scroll - 1 === scroll) {
        const lines = cached.lines.slice(0, -1);
        lines.unshift(this.renderPreviewLine(width, this.preview.lineAt(scroll)));
        this.previewPanelCache = { path: previewPath, width, height: bodyHeight, scroll, lines };
        return lines;
      }
    }

    const lines = this.preview
      .visibleLines(bodyHeight)
      .map((line) => this.renderPreviewLine(width, line));
    while (lines.length < bodyHeight) lines.push(this.renderPreviewLine(width));
    this.previewPanelCache = {
      path: previewPath,
      width,
      height: bodyHeight,
      scroll,
      lines,
    };
    return lines;
  }

  private renderPreviewLine(width: number, line = ""): string {
    return this.theme.bg(PREVIEW_BG, fit(width, line));
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
  files: FileRepositoryLike,
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

function findSearchIndex(results: SearchHit[], fullPath: string | undefined): number {
  if (!fullPath) return 0;
  const index = results.findIndex((result) => result.fullPath === fullPath);
  return index === -1 ? 0 : index;
}

function scoreTrackedFile(file: TrackedFile, query: string): number | undefined {
  if (query.length === 0) return 0;

  if (file.normalizedBaseName === query) return 700;
  if (file.normalizedPath === query) return 650;
  if (file.normalizedBaseName.startsWith(query)) {
    return 600 - (file.normalizedBaseName.length - query.length);
  }
  if (file.normalizedPath.startsWith(query)) {
    return 550 - (file.normalizedPath.length - query.length);
  }

  const baseIndex = file.normalizedBaseName.indexOf(query);
  if (baseIndex !== -1) return 500 - baseIndex;

  const pathIndex = file.normalizedPath.indexOf(query);
  if (pathIndex !== -1) return 400 - pathIndex;

  const gapPenalty = subsequenceGap(file.normalizedPath, query);
  if (gapPenalty === undefined) return undefined;
  return 250 - Math.min(200, gapPenalty);
}

function subsequenceGap(text: string, query: string): number | undefined {
  let queryIndex = 0;
  let lastMatch = -1;
  let gap = 0;

  for (let index = 0; index < text.length && queryIndex < query.length; index++) {
    if (text[index] !== query[queryIndex]) continue;
    if (lastMatch !== -1) gap += index - lastMatch - 1;
    lastMatch = index;
    queryIndex += 1;
  }

  return queryIndex === query.length ? gap : undefined;
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isWithin(target: string, base: string): boolean {
  const relativePath = path.relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function indent(depth: number): string {
  return "  ".repeat(depth);
}
