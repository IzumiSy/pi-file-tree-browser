import path from "node:path";

import { type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  matchesKey,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";

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
    this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
  }

  reload(selectedPath = this.currentRow()?.fullPath ?? this.treeRoot): void {
    this.rows = buildTreeRows(this.treeRoot, this.expandedPaths, this.files);
    this.selected = findRowIndex(this.rows, selectedPath);
    this.scroll = Math.min(this.scroll, Math.max(0, this.rows.length - 1));
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
      this.selected = parentIndex;
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
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + bodyHeight) {
      this.scroll = this.selected - bodyHeight + 1;
    }
    this.scroll = Math.max(0, this.scroll);
  }
}

export class PreviewModel {
  previewPath: string | undefined;
  previewData: PreviewData | undefined;
  previewLines: string[] | undefined;
  previewScroll = 0;
  previewPageStep = 1;

  constructor(private readonly files: FileRepository) {}

  isOpen(): boolean {
    return !!this.previewPath && !!this.previewLines;
  }

  open(fullPath: string): void {
    const preview = this.files.readPreview(fullPath);
    this.previewPath = fullPath;
    this.previewData = preview;
    this.previewScroll = 0;
    this.previewLines = this.files.renderPreviewLines(fullPath, preview);
  }

  close(): boolean {
    if (!this.previewPath || !this.previewLines) return false;
    this.previewPath = undefined;
    this.previewData = undefined;
    this.previewLines = undefined;
    this.previewScroll = 0;
    this.previewPageStep = 1;
    return true;
  }

  scrollBy(delta: number): void {
    if (!this.previewLines?.length) return;
    this.previewScroll = Math.max(0, this.previewScroll + delta);
  }

  invalidate(): void {
    if (this.previewPath && this.previewData) {
      this.previewLines = this.files.renderPreviewLines(
        this.previewPath,
        this.previewData,
      );
    }
  }
}

export class FileViewerOverlay {
  private readonly tree: FileTreeModel;
  private readonly preview: PreviewModel;

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
      if (this.preview.previewLines) {
        this.preview.scrollBy(-1);
      } else {
        this.tree.move(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "j")) {
      if (this.preview.previewLines) {
        this.preview.scrollBy(1);
      } else {
        this.tree.move(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+u")) {
      if (this.preview.previewLines) {
        this.preview.scrollBy(-this.preview.previewPageStep);
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      if (this.preview.previewLines) {
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
    const root = new Container();

    root.addChild(
      this.boxFromLines(
        [this.theme.fg("muted", ` ${this.tree.treeRoot}`)],
        paddingX,
        contentWidth,
        "selectedBg",
      ),
    );

    if (!this.preview.previewPath || !this.preview.previewLines) {
      const visibleRows = this.tree.rows.slice(
        this.tree.scroll,
        this.tree.scroll + Math.max(1, bodyRows),
      );

      if (width < 24) {
        root.addChild(
          this.boxFromLines(
            Array.from({ length: Math.max(1, bodyRows) }, (_, index) =>
              this.renderTreeLine(
                visibleRows[index],
                contentWidth,
                this.tree.scroll + index === this.tree.selected,
              ),
            ),
            paddingX,
            contentWidth,
          ),
        );
      } else {
        const gutterWidth = 1;
        const leftWidth = Math.max(
          10,
          Math.floor((contentWidth - gutterWidth) * 0.15),
        );
        const rightWidth = Math.max(10, contentWidth - gutterWidth - leftWidth);
        const leftLines = this.boxFromLines(
          Array.from({ length: Math.max(1, bodyRows) }, (_, index) =>
            this.renderTreeLine(
              visibleRows[index],
              leftWidth,
              this.tree.scroll + index === this.tree.selected,
            ),
          ),
          0,
          leftWidth,
        ).render(leftWidth);
        const rightLines = Array.from({ length: leftLines.length }, () =>
          " ".repeat(rightWidth),
        );

        root.addChild(
          new Text(this.joinColumns(leftLines, rightLines, gutterWidth), 0, 0),
        );
      }
    } else if (width < 24) {
      const visibleRows = this.tree.rows.slice(
        this.tree.scroll,
        this.tree.scroll + Math.max(1, bodyRows - 5),
      );
      root.addChild(
        this.boxFromLines(
          Array.from({ length: Math.max(1, bodyRows - 5) }, (_, index) =>
            this.renderTreeLine(
              visibleRows[index],
              contentWidth,
              this.tree.scroll + index === this.tree.selected,
            ),
          ),
          paddingX,
          contentWidth,
        ),
      );
      root.addChild(
        new Text(this.renderPreviewPanel(contentWidth, 5).join("\n"), paddingX, 0),
      );
    } else {
      const visibleRows = this.tree.rows.slice(
        this.tree.scroll,
        this.tree.scroll + Math.max(1, bodyRows),
      );
      const gutterWidth = 1;
      const leftWidth = Math.max(
        10,
        Math.floor((contentWidth - gutterWidth) * 0.15),
      );
      const rightWidth = Math.max(10, contentWidth - gutterWidth - leftWidth);
      const leftLines = this.boxFromLines(
        Array.from({ length: Math.max(1, bodyRows) }, (_, index) =>
          this.renderTreeLine(
            visibleRows[index],
            leftWidth,
            this.tree.scroll + index === this.tree.selected,
          ),
        ),
        0,
        leftWidth,
      ).render(leftWidth);
      const rightLines = this.renderPreviewPanel(rightWidth, bodyRows);

      root.addChild(
        new Text(this.joinColumns(leftLines, rightLines, gutterWidth), 0, 0),
      );
    }

    root.addChild(
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
      ),
    );

    return root.render(width);
  }

  invalidate(): void {
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

  private renderPreviewPanel(width: number, height: number): string[] {
    const bodyHeight = Math.max(1, height);
    this.preview.previewPageStep = Math.max(1, Math.floor(bodyHeight / 2));
    const maxScroll = Math.max(
      0,
      (this.preview.previewLines?.length ?? 0) - bodyHeight,
    );
    this.preview.previewScroll = Math.min(this.preview.previewScroll, maxScroll);

    return Array.from(
      { length: bodyHeight },
      (_, index) =>
        this.theme.bg(
          PREVIEW_BG,
          fit(width, this.preview.previewLines?.[this.preview.previewScroll + index] ?? ""),
        ),
    );
  }

  private joinColumns(
    left: string[],
    right: string[],
    gutterWidth: number,
  ): string {
    const lines: string[] = [];
    const gutter = " ".repeat(gutterWidth);
    const count = Math.max(left.length, right.length);

    for (let index = 0; index < count; index++) {
      lines.push(`${left[index] ?? ""}${gutter}${right[index] ?? ""}`);
    }

    return lines.join("\n");
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
