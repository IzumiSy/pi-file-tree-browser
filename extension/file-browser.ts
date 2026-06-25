import path from "node:path";

import fuzzysort from "fuzzysort";

import {
  searchHitKey,
  type SearchHit,
} from "./browser-results";
import {
  type FileRepository,
  type PreviewData,
  type TrackedFile,
} from "./file-repository";
import { type ContextPin } from "./pinned-files";

export type { SearchHit } from "./browser-results";

export type FileRepositoryLike = Pick<
  FileRepository,
  | "listEntries"
  | "readPreview"
  | "renderPreviewLines"
  | "readEditableText"
  | "listTrackedFiles"
  | "writeText"
  | "createEntry"
  | "moveEntry"
  | "deleteEntry"
  | "displayPath"
>;

export type TreeRow = {
  fullPath: string;
  label: string;
  isDirectory: boolean;
};

type PublishedResultsState = {
  title: string;
  results: SearchHit[];
  query: string;
  inputActive: boolean;
  selectedKey: string | undefined;
  scroll: number;
};

type SearchSourceItem = {
  fullPath: string;
  relativePath: string;
  baseName: string;
  isDirectory: boolean;
  startLine?: number;
  endLine?: number;
  reason?: string;
};

type SearchSourceKind = "tracked" | "results";

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
  private kind: SearchSourceKind = "tracked";
  private title = "tracked files";
  private inputActive = false;
  private sourceItems: SearchSourceItem[] = [];
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
    this.kind = "tracked";
    this.title = "tracked files";
    this.inputActive = true;
    this.refresh();
  }

  openResults(results: ReadonlyArray<SearchHit>, title = "AI results"): void {
    this.active = true;
    this.query = "";
    this.selected = 0;
    this.scroll = 0;
    this.kind = "results";
    this.title = title;
    this.inputActive = false;
    this.sourceItems = results.map((result) => ({
      fullPath: result.fullPath,
      relativePath: result.relativePath,
      baseName: path.basename(result.relativePath),
      isDirectory: result.isDirectory,
      ...(result.startLine === undefined ? {} : { startLine: result.startLine }),
      ...(result.endLine === undefined ? {} : { endLine: result.endLine }),
      ...(result.reason ? { reason: result.reason } : {}),
    }));
    this.recompute();
  }

  close(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.query = "";
    this.results = [];
    this.selected = 0;
    this.scroll = 0;
    this.inputActive = false;
    this.sourceItems = [];
    this.version += 1;
    return true;
  }

  refresh(force = false): void {
    this.trackedFiles = this.files.listTrackedFiles(this.cwd, force);
    if (this.kind !== "tracked") return;

    this.sourceItems = this.trackedFiles.map((file) => ({
      fullPath: file.fullPath,
      relativePath: file.relativePath,
      baseName: file.baseName,
      isDirectory: file.isDirectory,
    }));
    this.recompute();
  }

  headerText(): string {
    if (this.kind === "results" && !this.inputActive && this.query.length === 0) {
      return ` ${this.title} (${this.results.length})`;
    }
    return ` / ${this.query} (${this.results.length})`;
  }

  isInputActive(): boolean {
    return this.inputActive;
  }

  beginInput(): void {
    if (this.inputActive) return;
    this.inputActive = true;
    this.version += 1;
  }

  isPublishedResults(): boolean {
    return this.kind === "results";
  }

  snapshotPublishedResultsState(): PublishedResultsState | undefined {
    if (this.kind !== "results") return undefined;
    return {
      title: this.title,
      results: this.baseResults(),
      query: this.query,
      inputActive: this.inputActive,
      selectedKey: this.currentResult() ? searchHitKey(this.currentResult()!) : undefined,
      scroll: this.scroll,
    };
  }

  restorePublishedResultsState(state: PublishedResultsState): void {
    this.openResults(state.results, state.title);
    this.query = state.query;
    this.inputActive = state.inputActive;
    const selectedHit = state.selectedKey
      ? state.results.find((hit) => searchHitKey(hit) === state.selectedKey)
      : undefined;
    this.recompute(selectedHit);
    this.scroll = Math.min(state.scroll, Math.max(0, this.results.length - 1));
    this.version += 1;
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
    if (this.query.length === 0 && this.kind === "results") {
      this.inputActive = false;
    }
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

  private recompute(selectedHit = this.currentResult()): void {
    const query = this.query.trim();
    this.results = query.length === 0
      ? this.baseResults()
      : fuzzysort
          .go(query, this.sourceItems, {
            keys: SEARCH_KEYS,
            scoreFn: (result) =>
              Math.max(
                (result[0]?.score ?? Number.NEGATIVE_INFINITY) + BASENAME_SCORE_BOOST,
                result[1]?.score ?? Number.NEGATIVE_INFINITY,
                result[2]?.score ?? Number.NEGATIVE_INFINITY,
              ),
          })
          .map((result) => this.toSearchHit(result.obj, result.score));

    this.selected = findSearchIndex(this.results, selectedHit);
    this.scroll = Math.min(this.scroll, Math.max(0, this.results.length - 1));
    this.version += 1;
  }

  private baseResults(): SearchHit[] {
    const items = this.kind === "tracked"
      ? [...this.sourceItems].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      : this.sourceItems;
    return items.map((item) => this.toSearchHit(item));
  }

  private toSearchHit(item: SearchSourceItem, score = 0): SearchHit {
    return {
      fullPath: item.fullPath,
      relativePath: item.relativePath,
      score,
      isDirectory: item.isDirectory,
      ...(item.startLine === undefined ? {} : { startLine: item.startLine }),
      ...(item.endLine === undefined ? {} : { endLine: item.endLine }),
      ...(item.reason ? { reason: item.reason } : {}),
    };
  }
}

const SEARCH_KEYS = ["baseName", "relativePath", "reason"] as const;
const BASENAME_SCORE_BOOST = 0.2;

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

function findSearchIndex(results: SearchHit[], target: SearchHit | undefined): number {
  if (!target) return 0;
  const targetKey = searchHitKey(target);
  const index = results.findIndex((result) => searchHitKey(result) === targetKey);
  return index === -1 ? 0 : index;
}

export function formatSearchLocation(hit: SearchHit): string {
  if (hit.startLine === undefined) return "";
  if (hit.endLine === undefined || hit.endLine === hit.startLine) {
    return `:${hit.startLine}`;
  }
  return `:${hit.startLine}-${hit.endLine}`;
}

export function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

export { FileViewerOverlay } from "./file-viewer-overlay";
