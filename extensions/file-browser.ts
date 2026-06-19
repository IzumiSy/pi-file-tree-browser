import path from "node:path";

import fuzzysort from "fuzzysort";

import { type Theme } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";

import {
  type FileRepository,
  type PreviewData,
  type TrackedFile,
} from "./file-repository";
import {
  pinFullPath,
  pinKey,
  removeContextPin,
  togglePinnedPin,
  type ContextPin,
  type RangeContextPin,
} from "./pinned-files";
import { fit } from "./text-layout";

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
};

export type SearchHit = {
  fullPath: string;
  relativePath: string;
  score: number;
  isDirectory: boolean;
};

type BgColor = "selectedBg" | "customMessageBg" | "toolPendingBg";
type ViewerMode = "tree" | "search" | "help";
type InteractionMode =
  | "help"
  | "file-search"
  | "preview-search-input"
  | "preview-search-status"
  | "preview-selection"
  | "preview"
  | "browse";

const TREE_PAGE_STEP = 4;

const HELP_LINES = [
  "File browser help",
  "",
  "Navigation",
  "↑↓ / j k  Move selection or preview cursor",
  "Ctrl+U/D   Move list by 4 rows, help/preview by half a page",
  "h / ←      Go to parent directory or close preview",
  "l / →      Open directory or preview file",
  "Enter      Open directory, preview file, then open editor",
  "",
  "Search",
  "/          Search tracked files, or search inside previewed file",
  "Type       Filter while search is open",
  "Backspace  Delete search input",
  "Esc        Leave search/help or clear preview selection",
  "",
  "Pins",
  "s          Toggle next-turn pin for file or preview selection",
  "v          Mark preview range start/end, or remove pinned hunk",
  "",
  "Preview",
  "Ctrl+U/D   Move preview cursor by half a page",
  "n / N      Next / previous preview search match",
  "q          Close preview or browser",
  "r          Reload directory",
  "Ctrl+C     Cancel current mode/selection",
  "",
  "Press ? again to close this help.",
] as const;

export type FileViewerState = {
  treeRoot: string;
  selectedPath: string | undefined;
  treeScroll: number;
  previewPath: string | undefined;
  previewScroll: number;
  previewCursorLine: number;
};

export type FileViewerResult =
  | { kind: "close"; state: FileViewerState }
  | { kind: "edit"; fullPath: string; state: FileViewerState };

const FILE_SELECTION_BG: BgColor = "selectedBg";
const FILE_TREE_BG: BgColor = "customMessageBg";
const PREVIEW_BG: BgColor = "toolPendingBg";

export class FileTreeModel {
  treeRoot: string;
  rows: TreeRow[] = [];
  selected = 0;
  scroll = 0;
  version = 0;

  constructor(
    private readonly cwd: string,
    private readonly files: FileRepositoryLike,
  ) {
    this.treeRoot = cwd;
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
    this.rows = buildTreeRows(this.treeRoot, this.files);
    this.selected = findRowIndex(this.rows, selectedPath);
    this.scroll = Math.min(this.scroll, Math.max(0, this.rows.length - 1));
    this.version += 1;
  }

  expandSelected(onReroot: () => void): void {
    const row = this.currentRow();
    if (!row?.isDirectory) return;

    this.treeRoot = row.fullPath;
    onReroot();
    this.reload();
  }

  collapseSelected(onReroot: () => void): void {
    if (this.treeRoot === this.cwd) return;

    const previousRoot = this.treeRoot;
    this.treeRoot = path.dirname(this.treeRoot);
    onReroot();
    this.reload(previousRoot);
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
    const query = this.query.trim();
    this.results = query.length === 0
      ? [...this.trackedFiles]
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
          .map((file) => ({
            fullPath: file.fullPath,
            relativePath: file.relativePath,
            score: 0,
            isDirectory: file.isDirectory,
          }))
      : fuzzysort
          .go(query, this.trackedFiles, {
            keys: SEARCH_KEYS,
            scoreFn: (result) =>
              Math.max((result[0]?.score ?? 0) + BASENAME_SCORE_BOOST, result[1]?.score ?? 0),
          })
          .map((result) => ({
            fullPath: result.obj.fullPath,
            relativePath: result.obj.relativePath,
            score: result.score,
            isDirectory: result.obj.isDirectory,
          }));

    this.selected = findSearchIndex(this.results, selectedPath);
    this.scroll = Math.min(this.scroll, Math.max(0, this.results.length - 1));
    this.version += 1;
  }
}

const SEARCH_KEYS = ["baseName", "relativePath"] as const;
const BASENAME_SCORE_BOOST = 0.2;

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

export class PreviewSearchModel {
  query = "";
  matches: number[] = [];
  selected = 0;
  version = 0;
  phase: "closed" | "input" | "status" = "closed";
  private lines: string[] = [];

  open(lines: ReadonlyArray<string>, cursorLine: number): void {
    this.phase = "input";
    this.query = "";
    this.matches = [];
    this.selected = 0;
    this.lines = [...lines];
    this.version += 1;
    this.selectNearest(cursorLine);
  }

  clear(): boolean {
    if (this.phase === "closed" && this.query.length === 0 && this.matches.length === 0) {
      return false;
    }

    this.phase = "closed";
    this.query = "";
    this.matches = [];
    this.selected = 0;
    this.lines = [];
    this.version += 1;
    return true;
  }

  clearStatus(): boolean {
    if (this.phase !== "status") return false;
    this.phase = "closed";
    this.version += 1;
    return true;
  }

  isInput(): boolean {
    return this.phase === "input";
  }

  hasStatus(): boolean {
    return this.phase === "status" && this.query.length > 0;
  }

  canRepeat(): boolean {
    return this.query.length > 0 && this.matches.length > 0;
  }

  shouldRenderFooter(): boolean {
    return this.isInput() || this.hasStatus();
  }

  footerText(): string {
    if (this.isInput()) return ` / ${this.query}`;
    if (!this.hasStatus()) return "";
    if (this.matches.length === 0) return ` no matches: ${this.query}`;
    return ` ${this.query} ${this.selected + 1}/${this.matches.length}`;
  }

  insert(text: string, cursorLine: number): void {
    this.query += text;
    this.recompute(cursorLine);
  }

  backspace(cursorLine: number): void {
    if (this.query.length === 0) return;
    this.query = this.query.slice(0, -1);
    this.recompute(cursorLine);
  }

  submit(preview: PreviewModel): void {
    this.phase = "status";
    this.jumpToSelected(preview);
    this.version += 1;
  }

  move(delta: number): void {
    if (this.matches.length === 0) return;
    const count = this.matches.length;
    this.selected = (((this.selected + delta) % count) + count) % count;
    this.version += 1;
  }

  currentMatch(): number | undefined {
    return this.matches[this.selected];
  }

  jumpToSelected(preview: PreviewModel): void {
    const line = this.currentMatch();
    if (line === undefined) return;
    preview.focusLine(line);
  }

  private recompute(cursorLine: number): void {
    const query = this.query.toLowerCase();
    this.matches = query.length === 0
      ? []
      : this.lines.flatMap((line, index) => line.toLowerCase().includes(query) ? [index] : []);
    this.selectNearest(cursorLine);
    this.version += 1;
  }

  private selectNearest(cursorLine: number): void {
    const next = this.matches.findIndex((line) => line >= cursorLine);
    this.selected = next === -1 ? 0 : next;
  }
}

export class PreviewModel {
  previewPath: string | undefined;
  previewData: PreviewData | undefined;
  previewScroll = 0;
  previewPageStep = 1;
  cursorLine = 0;
  selectionAnchor: number | undefined;

  constructor(private readonly files: FileRepositoryLike) {}

  isOpen(): boolean {
    return !!this.previewPath && !!this.previewData;
  }

  open(fullPath: string): void {
    this.previewPath = fullPath;
    this.previewData = this.files.readPreview(fullPath);
    this.previewScroll = 0;
    this.cursorLine = 0;
    this.selectionAnchor = undefined;
  }

  close(): boolean {
    if (!this.previewPath || !this.previewData) return false;
    this.previewPath = undefined;
    this.previewData = undefined;
    this.previewScroll = 0;
    this.previewPageStep = 1;
    this.cursorLine = 0;
    this.selectionAnchor = undefined;
    return true;
  }

  moveCursor(delta: number): void {
    const maxLine = Math.max(0, this.lineCount() - 1);
    const next = Math.max(0, Math.min(maxLine, this.cursorLine + delta));
    this.cursorLine = next;
  }

  focusLine(lineIndex: number): void {
    const maxLine = Math.max(0, this.lineCount() - 1);
    const next = Math.max(0, Math.min(maxLine, lineIndex));
    this.cursorLine = next;
    this.previewScroll = next;
  }

  centerCursor(height: number): void {
    const bodyHeight = Math.max(1, height);
    const maxScroll = Math.max(0, this.lineCount() - bodyHeight);
    this.previewScroll = Math.max(
      0,
      Math.min(maxScroll, this.cursorLine - Math.floor(bodyHeight / 2)),
    );
  }

  scrollBy(delta: number): void {
    this.previewScroll = Math.max(0, this.previewScroll + delta);
  }

  keepCursorVisible(height: number): void {
    const bodyHeight = Math.max(1, height);
    const maxScroll = Math.max(0, this.lineCount() - bodyHeight);
    if (this.cursorLine < this.previewScroll) {
      this.previewScroll = this.cursorLine;
    }
    if (this.cursorLine >= this.previewScroll + bodyHeight) {
      this.previewScroll = this.cursorLine - bodyHeight + 1;
    }
    this.previewScroll = Math.max(0, Math.min(maxScroll, this.previewScroll));
  }

  toggleSelectionAnchor(): void {
    if (!this.previewPath || !this.previewData) return;
    this.selectionAnchor = this.selectionAnchor === undefined
      ? this.cursorLine
      : undefined;
  }

  clearSelection(): boolean {
    if (this.selectionAnchor === undefined) return false;
    this.selectionAnchor = undefined;
    return true;
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

  selectedRange(): { start: number; end: number } | undefined {
    if (!this.previewPath || !this.previewData || this.lineCount() === 0) return undefined;
    const anchor = this.selectionAnchor ?? this.cursorLine;
    return {
      start: Math.min(anchor, this.cursorLine),
      end: Math.max(anchor, this.cursorLine),
    };
  }

  createRangePin(): ContextPin | undefined {
    if (!this.previewPath || !this.previewData) return undefined;
    const range = this.selectedRange();
    if (!range) return undefined;

    return {
      kind: "range",
      fullPath: this.previewPath,
      startLine: range.start + 1,
      endLine: range.end + 1,
      snapshot: this.previewData.fallbackLines.slice(range.start, range.end + 1).join("\n"),
    };
  }

  restoreState(state: {
    previewPath: string | undefined;
    previewScroll: number;
    previewCursorLine: number;
  }): void {
    if (!state.previewPath) return;

    this.open(state.previewPath);
    const maxLine = Math.max(0, this.lineCount() - 1);
    this.cursorLine = Math.max(0, Math.min(maxLine, state.previewCursorLine));
    this.previewScroll = Math.max(0, Math.min(maxLine, state.previewScroll));
  }

  invalidate(): void {}
}

export class FileViewerOverlay {
  private readonly tree: FileTreeModel;
  private readonly search: FileSearchModel;
  private readonly preview: PreviewModel;
  private readonly previewSearch: PreviewSearchModel;
  private readonly commitChatContextPins: (pins: ContextPin[]) => void;
  private readonly done: (result: FileViewerResult) => void;
  private mode: ViewerMode = "tree";
  private treePageStep = TREE_PAGE_STEP;
  private previousMode: Exclude<ViewerMode, "help"> = "tree";
  private helpScroll = 0;
  private helpPageStep = 1;
  private headerCache: RenderCache | undefined;
  private treePanelCache: RenderCache | undefined;
  private searchPanelCache: RenderCache | undefined;

  constructor(
    private readonly cwd: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly files: FileRepositoryLike,
    private chatContextPins: ContextPin[],
    commitChatContextPinsOrUnusedSessionPin:
      | ((pins: ContextPin[]) => void)
      | ContextPin
      | undefined,
    doneOrCommitChatContextPins:
      | ((result: FileViewerResult) => void)
      | ((pins: ContextPin[]) => void),
    maybeDone?: (result: FileViewerResult) => void,
  ) {
    if (typeof commitChatContextPinsOrUnusedSessionPin === "function") {
      this.commitChatContextPins = commitChatContextPinsOrUnusedSessionPin;
      this.done = doneOrCommitChatContextPins as (result: FileViewerResult) => void;
    } else {
      this.commitChatContextPins = doneOrCommitChatContextPins as (pins: ContextPin[]) => void;
      this.done = maybeDone as (result: FileViewerResult) => void;
    }

    this.tree = new FileTreeModel(cwd, files);
    this.search = new FileSearchModel(cwd, files);
    this.preview = new PreviewModel(files);
    this.previewSearch = new PreviewSearchModel();
  }

  restoreState(state: FileViewerState | undefined): void {
    if (!state) return;

    this.tree.treeRoot = isWithin(state.treeRoot, this.cwd) ? state.treeRoot : this.cwd;
    this.tree.reload(state.selectedPath ?? state.previewPath ?? this.tree.treeRoot);
    this.tree.scroll = Math.max(0, Math.min(state.treeScroll, Math.max(0, this.tree.rows.length - 1)));
    this.preview.restoreState(state);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      if (this.dismissTransientMode()) {
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.dismissTransientMode()) {
        this.tui.requestRender();
        return;
      }
      if (this.closePreview()) {
        this.tui.requestRender();
        return;
      }
      return;
    }

    if (this.mode === "help") {
      this.handleHelpInput(data);
      return;
    }

    if (this.mode === "search" && this.handleSearchInput(data)) return;
    if (this.previewSearch.isInput() && this.handlePreviewSearchInput(data)) return;

    if (matchesKey(data, "?")) {
      this.openHelp();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "q")) {
      if (this.closePreview()) {
        this.tui.requestRender();
        return;
      }
      this.finish();
      return;
    }

    if (data === "/") {
      if (this.preview.isOpen()) {
        this.openPreviewSearch();
      } else {
        this.openSearch();
      }
      this.tui.requestRender();
      return;
    }

    if (data === "n") {
      if (this.preview.isOpen() && this.previewSearch.canRepeat()) {
        this.previewSearch.move(1);
        this.previewSearch.jumpToSelected(this.preview);
        this.tui.requestRender();
        return;
      }
    }

    if (data === "N") {
      if (this.preview.isOpen() && this.previewSearch.canRepeat()) {
        this.previewSearch.move(-1);
        this.previewSearch.jumpToSelected(this.preview);
        this.tui.requestRender();
        return;
      }
    }

    if (matchesKey(data, "up")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(-1);
      } else {
        this.tree.move(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(1);
      } else {
        this.tree.move(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "k")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(-1);
      } else {
        this.tree.move(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "j")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(1);
      } else {
        this.tree.move(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(-this.preview.previewPageStep);
        this.tui.requestRender();
      } else if (this.mode === "tree") {
        this.tree.move(-this.treePageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.preview.isOpen()) {
        this.preview.moveCursor(this.preview.previewPageStep);
        this.tui.requestRender();
      } else if (this.mode === "tree") {
        this.tree.move(this.treePageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      const row = this.tree.currentRow();
      if (row?.isDirectory) {
        this.tree.expandSelected(() => {
          this.preview.close();
          this.closePreviewSearch();
        });
      } else {
        this.openSelected();
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      if (this.preview.close()) {
        this.closePreviewSearch();
        this.tui.requestRender();
        return;
      }
      this.tree.collapseSelected(() => {
        this.preview.close();
        this.closePreviewSearch();
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

    if (matchesKey(data, "v")) {
      if (!this.preview.isOpen()) return;
      if (this.preview.selectionAnchor !== undefined) {
        this.preview.toggleSelectionAnchor();
      } else if (!this.removePinnedRangeAtCursor()) {
        this.preview.toggleSelectionAnchor();
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "s")) {
      this.toggleSelectedContextPin();
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
    const bodyRows = Math.max(1, terminalHeight - 1);

    if (this.mode === "search") {
      this.search.keepSelectionVisible(bodyRows);
    } else {
      this.tree.keepSelectionVisible(bodyRows);
    }

    const paddingX = width > 2 ? 1 : 0;
    const contentWidth = Math.max(1, width - paddingX * 2);
    const lines = [...this.renderHeader(width, paddingX, contentWidth)];

    if (this.mode === "help") {
      lines.push(...this.renderHelpPanel(contentWidth, bodyRows, paddingX));
      return lines;
    }

    if (this.mode === "search") {
      lines.push(...this.renderSearchPanel(contentWidth, bodyRows, paddingX));
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

    return lines;
  }

  invalidate(): void {
    this.headerCache = undefined;
    this.treePanelCache = undefined;
    this.searchPanelCache = undefined;
    this.preview.invalidate();
  }

  dispose(): void {}

  private finish(
    result?: { kind: "close" } | { kind: "edit"; fullPath: string },
  ): void {
    this.commitChatContextPins(this.chatContextPins);
    const state = this.snapshotState();
    if (!result || result.kind === "close") {
      this.done({ kind: "close", state });
      return;
    }

    this.done({ ...result, state });
  }

  private interactionMode(): InteractionMode {
    if (this.mode === "help") return "help";
    if (this.mode === "search") return "file-search";
    if (this.previewSearch.isInput()) return "preview-search-input";
    if (this.previewSearch.hasStatus()) return "preview-search-status";
    if (this.preview.selectionAnchor !== undefined) return "preview-selection";
    if (this.preview.isOpen()) return "preview";
    return "browse";
  }

  private dismissTransientMode(): boolean {
    switch (this.interactionMode()) {
      case "help":
        this.closeHelp();
        return true;
      case "file-search":
        this.closeSearch();
        return true;
      case "preview-search-input":
        this.closePreviewSearch();
        return true;
      case "preview-search-status":
        return this.previewSearch.clearStatus();
      case "preview-selection":
        return this.preview.clearSelection();
      case "preview":
      case "browse":
        return false;
    }
  }

  private closePreview(): boolean {
    const closed = this.preview.close();
    if (closed) this.previewSearch.clear();
    return closed;
  }

  private handleHelpInput(data: string): boolean {
    if (matchesKey(data, "?") || matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "enter")) {
      this.closeHelp();
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollHelpBy(-1);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollHelpBy(1);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "ctrl+u")) {
      this.scrollHelpBy(-this.helpPageStep);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "ctrl+d")) {
      this.scrollHelpBy(this.helpPageStep);
      this.tui.requestRender();
      return true;
    }

    return false;
  }

  private handleSearchInput(data: string): boolean {
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
      this.closeSearch(this.search.currentResult());
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

  private handlePreviewSearchInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      this.previewSearch.submit(this.preview);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "backspace")) {
      this.previewSearch.backspace(this.preview.cursorLine);
      this.previewSearch.jumpToSelected(this.preview);
      this.tui.requestRender();
      return true;
    }

    if (isPrintableInput(data)) {
      this.previewSearch.insert(data, this.preview.cursorLine);
      this.previewSearch.jumpToSelected(this.preview);
      this.tui.requestRender();
      return true;
    }

    return true;
  }

  private openSearch(): void {
    this.mode = "search";
    this.search.open();
    this.closePreview();
  }

  private openPreviewSearch(): void {
    if (!this.preview.previewData) return;
    this.previewSearch.open(this.preview.previewData.fallbackLines, this.preview.cursorLine);
  }

  private openHelp(): void {
    if (this.mode === "help") return;
    this.previousMode = this.mode;
    this.mode = "help";
    this.helpScroll = 0;
  }

  private closeHelp(): void {
    if (this.mode !== "help") return;
    this.mode = this.previousMode;
    this.helpScroll = 0;
  }

  private closePreviewSearch(): void {
    this.previewSearch.clear();
  }

  private closeSearch(revealHit?: SearchHit): void {
    this.search.close();
    this.mode = "tree";
    this.closePreview();
    if (!revealHit) return;
    if (revealHit.isDirectory) {
      this.tree.treeRoot = revealHit.fullPath;
      this.tree.reload();
      return;
    }
    this.revealInTree(revealHit.fullPath);
    this.preview.open(revealHit.fullPath);
    this.focusPinnedPreviewRange();
  }

  private revealInTree(fullPath: string): void {
    const nextRoot = path.dirname(fullPath);
    this.tree.treeRoot = isWithin(nextRoot, this.cwd) ? nextRoot : this.cwd;
    this.tree.reload(fullPath);
  }

  private openSelected(): void {
    const row = this.tree.currentRow();
    if (!row || row.fullPath.endsWith("#more")) return;

    if (row.isDirectory) {
      this.tree.expandSelected(() => {
        this.preview.close();
        this.closePreviewSearch();
      });
      return;
    }

    this.previewSearch.clear();
    this.preview.open(row.fullPath);
    this.focusPinnedPreviewRange();
  }

  private editPreviewedFile(): void {
    if (!this.preview.previewPath) return;
    this.finish({ kind: "edit", fullPath: this.preview.previewPath });
  }

  private snapshotState(): FileViewerState {
    return {
      treeRoot: this.tree.treeRoot,
      selectedPath: this.tree.currentRow()?.fullPath,
      treeScroll: this.tree.scroll,
      previewPath: this.preview.previewPath,
      previewScroll: this.preview.previewScroll,
      previewCursorLine: this.preview.cursorLine,
    };
  }

  private toggleSelectedContextPin(): void {
    const pin = this.selectedPin();
    if (!pin) return;

    this.chatContextPins = togglePinnedPin(this.chatContextPins, pin);
    this.preview.clearSelection();
  }

  private selectedPin(): ContextPin | undefined {
    if (this.mode === "search") {
      const result = this.search.currentResult();
      return result && !result.isDirectory
        ? { kind: "file", fullPath: result.fullPath }
        : undefined;
    }

    if (this.preview.isOpen()) {
      return this.preview.createRangePin();
    }

    const row = this.tree.currentRow();
    if (!row || row.isDirectory || row.fullPath.endsWith("#more")) return undefined;
    return { kind: "file", fullPath: row.fullPath };
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
    const marker = !row.isDirectory ? this.renderPinnedMarkers(row.fullPath) : "";
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
    const marker = hit.isDirectory ? "" : this.renderPinnedMarkers(hit.fullPath);
    const label = hit.isDirectory
      ? this.theme.fg("accent", `${hit.relativePath}/`)
      : hit.relativePath;
    const content = `${label}${marker}`;
    const line = fit(width, selected ? this.theme.bold(content) : content);
    return this.theme.bg(selected ? FILE_SELECTION_BG : FILE_TREE_BG, line);
  }

  private renderHeader(width: number, paddingX: number, contentWidth: number): string[] {
    const leftText = this.mode === "search"
      ? ` / ${this.search.query || ""} (${this.search.results.length})`
      : this.mode === "help"
        ? " help"
        : ` ${this.tree.treeRoot}`;
    const rightText = "Press ? for help";
    const leftWidth = Math.max(1, contentWidth - rightText.length - 1);
    const line = `${this.theme.fg("muted", fit(leftWidth, leftText))} ${this.theme.fg("accent", rightText)}`;
    const key = `${width}:${paddingX}:${contentWidth}:${this.mode}:${leftText}`;
    this.headerCache = getCachedLines(this.headerCache, key, () =>
      this.boxFromLines(
        [line],
        paddingX,
        contentWidth,
        "selectedBg",
      ).render(width),
    );
    return this.headerCache.lines;
  }

  private renderHelpPanel(width: number, height: number, paddingX: number): string[] {
    const bodyHeight = Math.max(1, height);
    this.helpPageStep = Math.max(1, Math.floor(bodyHeight / 2));
    const maxScroll = Math.max(0, HELP_LINES.length - bodyHeight);
    this.helpScroll = Math.min(this.helpScroll, maxScroll);

    return this.boxFromLines(
      Array.from({ length: bodyHeight }, (_, index) =>
        this.renderHelpLine(width, HELP_LINES[this.helpScroll + index]),
      ),
      paddingX,
      width,
    ).render(width + paddingX * 2);
  }

  private renderTreePanel(width: number, height: number, paddingX: number): string[] {
    const key = [
      width,
      height,
      paddingX,
      this.tree.version,
      this.tree.scroll,
      this.tree.selected,
      this.chatContextPins.map((pin) => pinKey(pin)).join("\u0000"),
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
      this.chatContextPins.map((pin) => pinKey(pin)).join("\u0000"),
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
    return Math.max(10, Math.min(48, contentWidth - gutterWidth));
  }

  private renderPreviewPanel(width: number, height: number): string[] {
    const showSearchFooter = this.previewSearch.shouldRenderFooter();
    const footerHeight = showSearchFooter && height > 1 ? 1 : 0;
    const bodyHeight = Math.max(1, height - footerHeight);
    this.preview.previewPageStep = Math.max(1, Math.floor(bodyHeight / 2));
    if (showSearchFooter) {
      this.preview.centerCursor(bodyHeight);
    } else {
      this.preview.keepCursorVisible(bodyHeight);
    }

    const lineCount = this.preview.lineCount();
    const gutterWidth = Math.max(1, `${Math.max(1, lineCount)}`.length);
    const selectedRange = this.preview.selectedRange();
    const visibleLines = this.preview.visibleLines(bodyHeight);
    const lines: string[] = [];

    for (let index = 0; index < bodyHeight; index += 1) {
      const lineIndex = this.preview.previewScroll + index;
      const lineNumber = lineIndex < lineCount ? lineIndex + 1 : undefined;
      const inRange = !!selectedRange
        && lineIndex >= selectedRange.start
        && lineIndex <= selectedRange.end;
      lines.push(
        this.renderPreviewLine(
          width,
          gutterWidth,
          visibleLines[index] ?? "",
          lineNumber,
          lineIndex === this.preview.cursorLine,
          inRange,
          this.previewLinePinned(lineIndex + 1),
        ),
      );
    }

    if (footerHeight > 0) {
      lines.push(this.renderPreviewSearchFooter(width));
    }

    return lines;
  }

  private renderPreviewSearchFooter(width: number): string {
    return this.theme.bg(
      PREVIEW_BG,
      fit(width, this.theme.fg("accent", this.previewSearch.footerText())),
    );
  }

  private renderPreviewLine(
    width: number,
    gutterWidth: number,
    line = "",
    lineNumber?: number,
    selected = false,
    inRange = false,
    pinned = false,
  ): string {
    const markerText = pinned
      ? "●"
      : inRange
        ? ">"
        : " ";
    const marker = markerText === ">"
      ? this.theme.fg("accent", markerText)
      : markerText === "●"
        ? this.theme.fg("warning", markerText)
        : markerText;
    const numberText = lineNumber === undefined
      ? " ".repeat(gutterWidth)
      : String(lineNumber).padStart(gutterWidth, " ");
    const prefixText = `${markerText} ${numberText} | `;
    const prefix = `${marker} ${this.theme.fg("muted", numberText)} | `;
    const content = `${prefix}${fit(Math.max(1, width - prefixText.length), line)}`;
    return this.theme.bg(selected ? FILE_SELECTION_BG : PREVIEW_BG, fit(width, content));
  }

  private renderHelpLine(width: number, line = ""): string {
    if (line === "File browser help") {
      return fit(width, this.theme.fg("accent", this.theme.bold(line)));
    }

    if (["Navigation", "Search", "Pins", "Preview"].includes(line)) {
      return fit(width, this.theme.fg("muted", line));
    }

    return fit(width, line);
  }

  private scrollHelpBy(delta: number): void {
    const maxScroll = Math.max(0, HELP_LINES.length - 1);
    this.helpScroll = Math.max(0, Math.min(maxScroll, this.helpScroll + delta));
  }

  private renderPinnedMarkers(fullPath: string): string {
    return this.chatContextPins.some((pin) => pinFullPath(pin) === fullPath)
      ? this.theme.fg("warning", " ●")
      : "";
  }

  private focusPinnedPreviewRange(): void {
    const range = this.previewPinnedRanges()[0];
    if (!range) return;
    this.preview.focusLine(range.startLine - 1);
  }

  private removePinnedRangeAtCursor(): boolean {
    const lineNumber = this.preview.cursorLine + 1;
    const pin = this.previewPinnedRanges().find((range) =>
      lineNumber >= range.startLine && lineNumber <= range.endLine,
    );
    if (!pin) return false;

    this.chatContextPins = removeContextPin(this.chatContextPins, pin);
    return true;
  }

  private previewPinnedRanges(): RangeContextPin[] {
    const previewPath = this.preview.previewPath;
    if (!previewPath) return [];

    return this.chatContextPins
      .filter((pin): pin is RangeContextPin =>
        pin.kind === "range" && pin.fullPath === previewPath,
      )
      .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  }

  private previewLinePinned(lineNumber: number): boolean {
    return this.chatContextPins.some((pin) =>
      pin.kind === "range"
      && pin.fullPath === this.preview.previewPath
      && lineNumber >= pin.startLine
      && lineNumber <= pin.endLine,
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
  files: FileRepositoryLike,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const entries = files.listEntries(root);
  const shown = entries.slice(0, 40);

  for (const entry of shown) {
    rows.push({
      fullPath: entry.fullPath,
      label: entry.isDirectory ? `${entry.name}/` : entry.name,
      isDirectory: entry.isDirectory,
    });
  }

  if (entries.length > shown.length) {
    rows.push({
      fullPath: `${root}#more`,
      label: `… ${entries.length - shown.length} more`,
      isDirectory: false,
    });
  }

  return rows;
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

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

function isWithin(target: string, base: string): boolean {
  const relativePath = path.relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

