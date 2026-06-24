import path from "node:path";

import { type Theme } from "@earendil-works/pi-coding-agent";
import { Box, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";

import {
  isWithin,
  type SearchHit,
} from "./browser-results";
import {
  FileSearchModel,
  FileTreeModel,
  PreviewModel,
  PreviewSearchModel,
  formatSearchLocation,
  isPrintableInput,
  type FileRepositoryLike,
  type FileViewerResult,
  type FileViewerState,
  type TreeRow,
} from "./file-browser";
import {
  pinFullPath,
  pinKey,
  removeContextPin,
  togglePinnedPin,
  type ContextPin,
  type RangeContextPin,
} from "./pinned-files";
import { fit } from "./text-layout";

type BgColor = "selectedBg" | "customMessageBg" | "toolPendingBg";
type ViewerScreen = "tree" | "search" | "preview" | "help";

type RenderCache = {
  key: string;
  lines: string[];
};

const TREE_PAGE_STEP = 4;

const HELP_LINES = [
  "File browser help",
  "",
  "Navigation",
  "↑↓ / j k  Move selection or preview cursor",
  "Ctrl+U/D   Move list by 4 rows, help/preview by half a page",
  "h / ←      Go to parent directory, leave search, or close preview",
  "l / →      Open directory or preview file",
  "Enter      Open directory, preview file, then open editor",
  "",
  "Pins",
  "Ctrl+S     Toggle next-turn pin for whole file",
  "s          Toggle next-turn pin for current file or preview selection",
  "v          Mark preview range start/end, or remove pinned hunk",
  "",
  "Search",
  "/          Search tracked files, or search inside previewed file",
  "Type       Filter while search is open",
  "Backspace  Delete search input",
  "Esc        Leave search/help, close preview, or clear selection",
  "",
  "Preview",
  "Ctrl+U/D   Move preview cursor by half a page",
  "n / N      Next / previous preview search match",
  "o          Open previewed file in the tree view",
  "q          Close current screen or browser",
  "r          Reload directory",
  "Ctrl+C     Cancel current mode/selection",
  "Press ? again to close this help.",
] as const;

const FILE_SELECTION_BG: BgColor = "selectedBg";
const FILE_TREE_BG: BgColor = "customMessageBg";
const PREVIEW_BG: BgColor = "toolPendingBg";
const MIN_SPLIT_PANEL_WIDTH = 10;
const MIN_TREE_PANEL_WIDTH = 25;
const MAX_TREE_PANEL_WIDTH = 50;

function getCachedLines(
  cache: RenderCache | undefined,
  key: string,
  build: () => string[],
): RenderCache {
  if (cache?.key === key) return cache;
  return { key, lines: build() };
}

export class FileViewerOverlay {
  private readonly tree: FileTreeModel;
  private readonly search: FileSearchModel;
  private readonly preview: PreviewModel;
  private readonly previewSearch: PreviewSearchModel;
  private readonly commitChatContextPins: (pins: ContextPin[]) => void;
  private readonly done: (result: FileViewerResult) => void;
  private screens: ViewerScreen[] = ["tree"];
  private treePageStep = TREE_PAGE_STEP;
  private helpScroll = 0;
  private helpPageStep = 1;
  private headerCache: RenderCache | undefined;
  private treePanelCache: RenderCache | undefined;
  private searchPanelCache: RenderCache | undefined;
  private finished = false;

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
    this.screens = state.previewPath ? ["tree", "preview"] : ["tree"];
  }

  openResults(title: string, results: ReadonlyArray<SearchHit>): void {
    this.preview.close();
    this.closePreviewSearch();
    this.search.openResults(results, title);
    this.screens = ["search"];
  }

  handleInput(data: string): void {
    if (this.finished) return;

    if (matchesKey(data, "q")) {
      if (this.closeCurrentScreen()) {
        this.tui.requestRender();
      } else {
        this.finish();
      }
      return;
    }

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
      if (this.closeCurrentScreen()) {
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "?")) {
      if (this.activeScreen() === "help") {
        this.closeCurrentScreen();
      } else {
        this.openHelp();
      }
      this.tui.requestRender();
      return;
    }

    if (this.activeScreen() === "help") {
      this.handleHelpInput(data);
      return;
    }

    if (this.activeScreen() === "search") {
      if (this.handleSearchInput(data)) return;
      if (matchesKey(data, "ctrl+s")) {
        this.toggleWholeFileContextPin();
        this.tui.requestRender();
      } else if (matchesKey(data, "s")) {
        this.toggleSelectedContextPin();
        this.tui.requestRender();
      }
      return;
    }

    if (this.activeScreen() === "preview" && this.previewSearch.isInput()) {
      this.handlePreviewSearchInput(data);
      return;
    }

    if (data === "/") {
      if (this.activeScreen() === "preview") {
        this.openPreviewSearch();
      } else {
        this.openSearch();
      }
      this.tui.requestRender();
      return;
    }

    if (data === "n") {
      if (this.activeScreen() === "preview" && this.previewSearch.canRepeat()) {
        this.previewSearch.move(1);
        this.previewSearch.jumpToSelected(this.preview);
        this.tui.requestRender();
        return;
      }
    }

    if (data === "N") {
      if (this.activeScreen() === "preview" && this.previewSearch.canRepeat()) {
        this.previewSearch.move(-1);
        this.previewSearch.jumpToSelected(this.preview);
        this.tui.requestRender();
        return;
      }
    }

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.activeScreen() === "preview") {
        this.preview.moveCursor(-1);
      } else {
        this.tree.move(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.activeScreen() === "preview") {
        this.preview.moveCursor(1);
      } else {
        this.tree.move(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      if (this.activeScreen() === "preview") {
        this.preview.moveCursor(-this.preview.previewPageStep);
        this.tui.requestRender();
      } else if (this.activeScreen() === "tree") {
        this.tree.move(-this.treePageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.activeScreen() === "preview") {
        this.preview.moveCursor(this.preview.previewPageStep);
        this.tui.requestRender();
      } else if (this.activeScreen() === "tree") {
        this.tree.move(this.treePageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      if (this.activeScreen() !== "tree") return;
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
      if (this.activeScreen() === "preview") {
        this.closeCurrentScreen();
      } else {
        this.tree.collapseSelected(() => {
          this.preview.close();
          this.closePreviewSearch();
        });
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.activeScreen() === "preview" && this.preview.previewPath) {
        this.editPreviewedFile();
        return;
      }
      this.openSelected();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "o")) {
      if (this.openPreviewInTreeView()) {
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "v")) {
      if (this.activeScreen() !== "preview") return;
      if (this.preview.selectionAnchor !== undefined) {
        this.preview.toggleSelectionAnchor();
      } else if (!this.removePinnedRangeAtCursor()) {
        this.preview.toggleSelectionAnchor();
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+s")) {
      this.toggleWholeFileContextPin();
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
    const activeScreen = this.activeScreen();
    const leftPanelScreen = this.leftPanelScreen();

    if (leftPanelScreen === "search") {
      this.search.keepSelectionVisible(bodyRows);
    } else {
      this.tree.keepSelectionVisible(bodyRows);
    }

    const paddingX = width > 2 ? 1 : 0;
    const contentWidth = Math.max(1, width - paddingX * 2);
    const lines = [...this.renderHeader(width, paddingX, contentWidth)];

    if (activeScreen === "help") {
      lines.push(...this.renderHelpPanel(contentWidth, bodyRows, paddingX));
      return lines;
    }

    if (activeScreen === "search") {
      if (width < 24) {
        lines.push(...this.renderSearchPanel(contentWidth, bodyRows, paddingX, contentWidth));
      } else {
        lines.push(...this.renderSearchPanel(width, bodyRows, 0, width));
      }
      return lines;
    }

    if (activeScreen === "tree") {
      const gutterWidth = 1;
      if (width < 24 || contentWidth < MIN_TREE_PANEL_WIDTH + gutterWidth + MIN_SPLIT_PANEL_WIDTH) {
        lines.push(...this.renderTreePanel(contentWidth, bodyRows, paddingX));
      } else {
        const leftWidth = this.leftPanelWidth(contentWidth, gutterWidth, "tree");
        const rightWidth = Math.max(MIN_SPLIT_PANEL_WIDTH, contentWidth - gutterWidth - leftWidth);
        const leftLines = this.renderTreePanel(leftWidth, bodyRows, 0);
        const rightLines = Array.from({ length: leftLines.length }, () => " ".repeat(rightWidth));
        lines.push(...this.joinColumns(leftLines, rightLines, gutterWidth));
      }
      return lines;
    }

    if (width < 24) {
      lines.push(...this.renderLeftPanel(leftPanelScreen, contentWidth, Math.max(1, bodyRows - 5), paddingX));
      lines.push(...this.renderPreviewPanel(contentWidth, 5));
    } else {
      const gutterWidth = 1;
      const leftWidth = this.leftPanelWidth(contentWidth, gutterWidth, leftPanelScreen);
      const rightWidth = Math.max(MIN_SPLIT_PANEL_WIDTH, contentWidth - gutterWidth - leftWidth);
      const leftLines = this.renderLeftPanel(leftPanelScreen, leftWidth, bodyRows, 0);
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
    if (this.finished) return;
    this.finished = true;

    this.commitChatContextPins(this.chatContextPins);
    const state = this.snapshotState();
    if (!result || result.kind === "close") {
      this.done({ kind: "close", state });
      return;
    }

    this.done({ ...result, state });
  }

  private activeScreen(): ViewerScreen {
    return this.screens[this.screens.length - 1] ?? "tree";
  }

  private previousScreen(): ViewerScreen | undefined {
    return this.screens.length > 1
      ? this.screens[this.screens.length - 2]
      : undefined;
  }

  private leftPanelScreen(): "tree" | "search" {
    return this.activeScreen() === "search"
      || (this.activeScreen() === "preview" && this.previousScreen() === "search")
      ? "search"
      : "tree";
  }

  private closeCurrentScreen(): boolean {
    switch (this.activeScreen()) {
      case "help":
        this.screens.pop();
        this.helpScroll = 0;
        return true;
      case "preview":
        this.preview.close();
        this.previewSearch.clear();
        this.screens.pop();
        return true;
      case "search":
        if (this.screens.length <= 1) return false;
        this.search.close();
        this.screens.pop();
        return true;
      case "tree":
        return false;
    }
  }

  private dismissTransientMode(): boolean {
    if (this.previewSearch.isInput()) {
      this.closePreviewSearch();
      return true;
    }
    if (this.previewSearch.hasStatus()) {
      return this.previewSearch.clearStatus();
    }
    if (this.preview.selectionAnchor !== undefined) {
      return this.preview.clearSelection();
    }
    return false;
  }

  private handleHelpInput(data: string): boolean {
    if (matchesKey(data, "enter")) {
      this.closeCurrentScreen();
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
    const browsingPublishedResults = this.search.isPublishedResults() && !this.search.isInputActive();

    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      if (this.closeCurrentScreen()) {
        this.tui.requestRender();
      }
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

    if (browsingPublishedResults && matchesKey(data, "ctrl+u")) {
      this.search.move(-this.treePageStep);
      this.tui.requestRender();
      return true;
    }

    if (browsingPublishedResults && matchesKey(data, "ctrl+d")) {
      this.search.move(this.treePageStep);
      this.tui.requestRender();
      return true;
    }

    if (browsingPublishedResults && matchesKey(data, "k")) {
      this.search.move(-1);
      this.tui.requestRender();
      return true;
    }

    if (browsingPublishedResults && matchesKey(data, "j")) {
      this.search.move(1);
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "enter") || (browsingPublishedResults && (matchesKey(data, "right") || matchesKey(data, "l")))) {
      this.openSearchResult(this.search.currentResult());
      this.tui.requestRender();
      return true;
    }

    if (matchesKey(data, "backspace")) {
      if (!this.search.isInputActive()) return true;
      this.search.backspace();
      this.tui.requestRender();
      return true;
    }

    if (data === "/" && !this.search.isInputActive()) {
      this.search.beginInput();
      this.tui.requestRender();
      return true;
    }

    if (browsingPublishedResults) {
      return false;
    }

    if (isPrintableInput(data)) {
      this.search.beginInput();
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
    this.search.open();
    this.closePreviewSearch();
    this.screens = ["tree", "search"];
  }

  private openPreviewSearch(): void {
    if (!this.preview.previewData) return;
    this.previewSearch.open(this.preview.previewData.fallbackLines, this.preview.cursorLine);
  }

  private openHelp(): void {
    if (this.activeScreen() === "help") return;
    this.screens.push("help");
    this.helpScroll = 0;
  }

  private closePreviewSearch(): void {
    this.previewSearch.clear();
  }

  private openSearchResult(revealHit?: SearchHit): void {
    if (!revealHit) return;
    if (revealHit.isDirectory) {
      this.search.close();
      this.screens = ["tree"];
      this.tree.treeRoot = revealHit.fullPath;
      this.tree.reload();
      return;
    }

    this.revealInTree(revealHit.fullPath);
    this.preview.open(revealHit.fullPath);
    if (this.activeScreen() !== "preview") {
      this.screens.push("preview");
    }
    if (revealHit.startLine !== undefined) {
      this.preview.focusLine(revealHit.startLine - 1);
      return;
    }
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
    if (this.activeScreen() !== "preview") {
      this.screens.push("preview");
    }
    this.focusPinnedPreviewRange();
  }

  private openPreviewInTreeView(): boolean {
    if (this.activeScreen() !== "preview") return false;
    if (this.previousScreen() !== "search") return false;
    if (!this.preview.previewPath) return false;

    this.revealInTree(this.preview.previewPath);
    const nextScreens = this.screens.filter((screen, index) =>
      !(screen === "search" && index === this.screens.length - 2),
    );
    this.screens = nextScreens[0] === "tree"
      ? nextScreens
      : ["tree", ...nextScreens];
    return true;
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

  private toggleWholeFileContextPin(): void {
    const pin = this.selectedFilePin();
    if (!pin) return;

    this.chatContextPins = togglePinnedPin(this.chatContextPins, pin);
    this.preview.clearSelection();
  }

  private toggleSelectedContextPin(): void {
    const pin = this.selectedPin();
    if (!pin) return;

    this.chatContextPins = togglePinnedPin(this.chatContextPins, pin);
    this.preview.clearSelection();
  }

  private selectedFilePin(): ContextPin | undefined {
    if (this.activeScreen() === "search") {
      const result = this.search.currentResult();
      return result && !result.isDirectory
        ? { kind: "file", fullPath: result.fullPath }
        : undefined;
    }

    if (this.activeScreen() === "preview" && this.preview.previewPath) {
      return { kind: "file", fullPath: this.preview.previewPath };
    }

    const row = this.tree.currentRow();
    if (!row || row.isDirectory || row.fullPath.endsWith("#more")) return undefined;
    return { kind: "file", fullPath: row.fullPath };
  }

  private selectedPin(): ContextPin | undefined {
    if (this.activeScreen() === "search") {
      const result = this.search.currentResult();
      return result && !result.isDirectory
        ? { kind: "file", fullPath: result.fullPath }
        : undefined;
    }

    if (this.activeScreen() === "preview") {
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
      ? new Box(paddingX, 0, (text) => this.applyPersistentBackground(bg, text))
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
    return this.applyPersistentBackground(selected ? FILE_SELECTION_BG : FILE_TREE_BG, line);
  }

  private renderSearchLine(
    hit: SearchHit | undefined,
    width: number,
    selected: boolean,
    contentWidth = width,
  ): string {
    if (!hit) return this.theme.bg(FILE_TREE_BG, " ".repeat(width));
    const marker = hit.isDirectory ? "" : this.renderPinnedMarkers(hit.fullPath);
    const label = hit.isDirectory
      ? `${hit.relativePath}/`
      : this.renderSearchFileLabel(hit);
    const content = `${label}${marker}`;
    const clipped = fit(contentWidth, selected ? this.theme.bold(content) : content);
    const line = clipped + " ".repeat(Math.max(0, width - contentWidth));
    return this.applyPersistentBackground(selected ? FILE_SELECTION_BG : FILE_TREE_BG, line);
  }

  private renderSearchFileLabel(hit: SearchHit): string {
    const location = formatSearchLocation(hit);
    const fileLabel = `${hit.relativePath}${location}`;

    if (!hit.reason) return fileLabel;
    return `${fileLabel}${this.theme.fg("muted", " │ ")}${this.theme.fg("muted", hit.reason)}`;
  }

  private renderHeader(width: number, paddingX: number, contentWidth: number): string[] {
    const activeScreen = this.activeScreen();
    const leftText = activeScreen === "help"
      ? " help"
      : this.leftPanelScreen() === "search"
        ? this.search.headerText()
        : ` ${this.tree.treeRoot}`;
    const qLabel = this.screens.length > 1 ? "q back" : "q close";
    const rightText = activeScreen === "help"
      ? `${qLabel} • ? close`
      : activeScreen === "preview"
        ? `${qLabel} • h back`
        : `${qLabel} • ? help`;
    const leftWidth = Math.max(1, contentWidth - rightText.length - 1);
    const line = `${this.theme.fg("muted", fit(leftWidth, leftText))} ${this.theme.fg("accent", rightText)}`;
    const key = `${width}:${paddingX}:${contentWidth}:${activeScreen}:${leftText}:${rightText}`;
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

  private renderSearchPanel(
    width: number,
    height: number,
    paddingX: number,
    contentWidth = width,
  ): string[] {
    const key = [
      width,
      height,
      paddingX,
      contentWidth,
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
            contentWidth,
          ),
        ),
        paddingX,
        width,
      ).render(width + paddingX * 2);
    });
    return this.searchPanelCache.lines;
  }

  private renderLeftPanel(
    screen: "tree" | "search",
    width: number,
    height: number,
    paddingX: number,
  ): string[] {
    return screen === "search"
      ? this.renderSearchPanel(width, height, paddingX)
      : this.renderTreePanel(width, height, paddingX);
  }

  private leftPanelWidth(
    contentWidth: number,
    gutterWidth: number,
    screen: "tree" | "search",
  ): number {
    const availableWidth = Math.max(1, contentWidth - gutterWidth);
    const ratio = screen === "search" ? 0.5 : 0.25;
    const minWidth = screen === "tree" ? MIN_TREE_PANEL_WIDTH : MIN_SPLIT_PANEL_WIDTH;
    const baseMaxWidth = Math.max(minWidth, availableWidth - MIN_SPLIT_PANEL_WIDTH);
    const maxWidth = screen === "tree"
      ? Math.max(minWidth, Math.min(baseMaxWidth, MAX_TREE_PANEL_WIDTH))
      : baseMaxWidth;
    return Math.max(minWidth, Math.min(maxWidth, Math.floor(availableWidth * ratio)));
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
    const showRangeSelection = this.preview.selectionAnchor !== undefined;
    const visibleLines = this.preview.visibleLines(bodyHeight);
    const lines: string[] = [];

    for (let index = 0; index < bodyHeight; index += 1) {
      const lineIndex = this.preview.previewScroll + index;
      const lineNumber = lineIndex < lineCount ? lineIndex + 1 : undefined;
      const inRange = showRangeSelection
        && !!selectedRange
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
    return this.applyPersistentBackground(
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
    return this.applyPersistentBackground(selected ? FILE_SELECTION_BG : PREVIEW_BG, fit(width, content));
  }

  private applyPersistentBackground(bg: BgColor, text: string): string {
    const sentinel = "\u0000";
    const styled = this.theme.bg(bg, sentinel);
    const sentinelIndex = styled.indexOf(sentinel);
    if (sentinelIndex === -1) {
      return this.theme.bg(bg, text);
    }

    const prefix = styled.slice(0, sentinelIndex);
    const suffix = styled.slice(sentinelIndex + sentinel.length);
    const reapplied = prefix
      ? text.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`)
      : text;
    return `${prefix}${reapplied}${suffix}`;
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
