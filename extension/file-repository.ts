import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  getLanguageFromPath,
  getMarkdownTheme,
  highlightCode,
} from "@earendil-works/pi-coding-agent";

const FG_RESET = "\x1b[39m";

export type TreeEntry = {
  name: string;
  fullPath: string;
  isDirectory: boolean;
};

export type PreviewData = {
  rawText?: string;
  fallbackLines: string[];
  highlight: boolean;
  renderedWindow?: {
    start: number;
    end: number;
    lines: string[];
  };
};

export type TrackedFile = {
  fullPath: string;
  relativePath: string;
  baseName: string;
  isDirectory: boolean;
};

const PREVIEW_HIGHLIGHT_BUFFER_LINES = 40;
const PREVIEW_HIGHLIGHT_CONTEXT_LINES = 20;

export class FileRepository {
  private readonly trackedFilesCache = new Map<string, TrackedFile[]>();

  constructor(
    private readonly renderHighlighted: (code: string, language?: string) => string[] =
      highlightCode,
  ) {}
  listEntries(dir: string): TreeEntry[] {
    try {
      return sortEntries(
        readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          fullPath: path.join(dir, entry.name),
          isDirectory: entry.isDirectory(),
        })),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          name: `[error: ${message}]`,
          fullPath: dir,
          isDirectory: false,
        },
      ];
    }
  }

  readPreview(fullPath: string): PreviewData {
    try {
      const buffer = readFileSync(fullPath);
      if (buffer.includes(0)) {
        return {
          fallbackLines: [" binary file ", fullPath],
          highlight: false,
        };
      }

      const text = buffer.toString("utf8").replace(/\t/g, "  ");
      const lines = text.split(/\r?\n/);
      const preview = lines.length > 0 ? lines : [""];

      return {
        rawText: preview.join("\n"),
        fallbackLines: preview,
        highlight: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        fallbackLines: [` error: ${message} `],
        highlight: false,
      };
    }
  }

  renderPreviewLines(
    fullPath: string,
    preview: PreviewData,
    start = 0,
    count = preview.fallbackLines.length,
  ): string[] {
    const end = Math.min(preview.fallbackLines.length, start + count);
    if (!preview.highlight || !preview.rawText) {
      return preview.fallbackLines.slice(start, end);
    }

    const bufferedStart = Math.max(0, start - PREVIEW_HIGHLIGHT_BUFFER_LINES);
    const bufferedEnd = Math.min(
      preview.fallbackLines.length,
      end + PREVIEW_HIGHLIGHT_BUFFER_LINES,
    );
    const cached = preview.renderedWindow;
    if (cached && bufferedStart >= cached.start && bufferedEnd <= cached.end) {
      return cached.lines.slice(bufferedStart - cached.start, bufferedEnd - cached.start).slice(
        start - bufferedStart,
        end - bufferedStart,
      );
    }

    const language = getLanguageFromPath(fullPath);
    let next = cached;

    if (!next || bufferedEnd <= next.start || bufferedStart >= next.end) {
      next = {
        start: bufferedStart,
        end: bufferedEnd,
        lines: this.highlightSegment(preview, bufferedStart, bufferedEnd, language),
      };
    } else {
      if (bufferedStart < next.start) {
        const segmentEnd = Math.min(next.start + PREVIEW_HIGHLIGHT_CONTEXT_LINES, bufferedEnd);
        const prefix = this.highlightSegment(preview, bufferedStart, segmentEnd, language);
        next = {
          start: bufferedStart,
          end: next.end,
          lines: prefix.concat(next.lines.slice(segmentEnd - next.start)),
        };
      }

      if (bufferedEnd > next.end) {
        const segmentStart = Math.max(next.end - PREVIEW_HIGHLIGHT_CONTEXT_LINES, bufferedStart);
        const suffix = this.highlightSegment(preview, segmentStart, bufferedEnd, language);
        next = {
          start: next.start,
          end: bufferedEnd,
          lines: next.lines.slice(0, segmentStart - next.start).concat(suffix),
        };
      }

      if (next.start < bufferedStart || next.end > bufferedEnd) {
        next = {
          start: bufferedStart,
          end: bufferedEnd,
          lines: next.lines.slice(bufferedStart - next.start, bufferedEnd - next.start),
        };
      }
    }

    preview.renderedWindow = next;
    return next.lines.slice(start - next.start, end - next.start);
  }

  private highlightSegment(
    preview: PreviewData,
    start: number,
    end: number,
    language: string | undefined,
  ): string[] {
    if (language === "markdown") {
      return this.renderMarkdownSegment(preview.fallbackLines, start, end);
    }

    return this.renderHighlighted(
      preview.fallbackLines.slice(start, end).join("\n"),
      language,
    ).map(ensureForegroundReset);
  }

  private renderMarkdownSegment(
    lines: readonly string[],
    start: number,
    end: number,
  ): string[] {
    const theme = getMarkdownTheme();
    const rendered: string[] = [];
    let fence = findMarkdownFence(lines, start);
    let index = start;

    while (index < end) {
      const line = lines[index] ?? "";

      if (fence) {
        if (isMarkdownFenceClose(line, fence)) {
          rendered.push(theme.codeBlockBorder(line));
          fence = undefined;
          index += 1;
          continue;
        }

        let blockEnd = index;
        while (blockEnd < end && !isMarkdownFenceClose(lines[blockEnd] ?? "", fence)) {
          blockEnd += 1;
        }

        const blockLines = lines.slice(index, blockEnd);
        const highlighted = theme.highlightCode
          ? theme.highlightCode(blockLines.join("\n"), fence.language)
          : blockLines.map((value) => theme.codeBlock(value));
        rendered.push(...highlighted);
        index = blockEnd;
        continue;
      }

      const nextFence = parseMarkdownFence(line);
      if (nextFence) {
        rendered.push(theme.codeBlockBorder(line));
        fence = nextFence;
        index += 1;
        continue;
      }

      rendered.push(styleMarkdownLine(line, theme));
      index += 1;
    }

    return rendered.map(ensureForegroundReset);
  }

  readEditableText(fullPath: string): { kind: "binary" } | { kind: "text"; text: string } {
    const buffer = readFileSync(fullPath);
    if (buffer.includes(0)) return { kind: "binary" };
    return { kind: "text", text: buffer.toString("utf8") };
  }

  listTrackedFiles(cwd: string, refresh = false): TrackedFile[] {
    const cached = this.trackedFilesCache.get(cwd);
    if (cached && !refresh) return cached;

    const files = this.readTrackedFiles(cwd);
    this.trackedFilesCache.set(cwd, files);
    return files;
  }

  writeText(fullPath: string, text: string): void {
    writeFileSync(fullPath, text, "utf8");
  }

  createEntry(fullPath: string, kind: "file" | "directory"): void {
    if (kind === "directory") {
      mkdirSync(fullPath);
      return;
    }

    writeFileSync(fullPath, "", { encoding: "utf8", flag: "wx" });
  }

  moveEntry(fullPath: string, nextFullPath: string): void {
    if (fullPath === nextFullPath) return;
    if (existsSync(nextFullPath)) {
      throw new Error(`target already exists: ${nextFullPath}`);
    }
    renameSync(fullPath, nextFullPath);
  }

  deleteEntry(fullPath: string, isDirectory: boolean): void {
    if (isDirectory) {
      rmdirSync(fullPath);
      return;
    }

    unlinkSync(fullPath);
  }

  displayPath(fullPath: string, cwd: string): string {
    const relativePath = path.relative(cwd, fullPath);
    if (
      relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath)
    ) {
      return relativePath;
    }

    return fullPath;
  }

  private readTrackedFiles(cwd: string): TrackedFile[] {
    const result = spawnSync("git", ["ls-files", "-z"], {
      cwd,
      encoding: "utf8",
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];

    const entries = new Map<string, TrackedFile>();

    for (const relativePath of result.stdout
      .split("\0")
      .filter((value): value is string => value.length > 0)) {
      entries.set(relativePath, {
        fullPath: path.join(cwd, relativePath),
        relativePath,
        baseName: path.basename(relativePath),
        isDirectory: false,
      });

      let directory = path.dirname(relativePath);
      while (directory !== "." && directory !== "") {
        if (!entries.has(directory)) {
          entries.set(directory, {
            fullPath: path.join(cwd, directory),
            relativePath: directory,
            baseName: path.basename(directory),
            isDirectory: true,
          });
        }
        directory = path.dirname(directory);
      }
    }

    return [...entries.values()].sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.relativePath.localeCompare(b.relativePath);
    });
  }
}

type MarkdownTheme = ReturnType<typeof getMarkdownTheme>;

type MarkdownFence = {
  char: "`" | "~";
  length: number;
  language: string | undefined;
};

function ensureForegroundReset(line: string): string {
  return line.endsWith(FG_RESET) ? line : `${line}${FG_RESET}`;
}

function parseMarkdownFence(line: string): MarkdownFence | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})([^`]*)$/.exec(line);
  const marker = match?.[1] ?? "";
  if (marker.length < 3) return undefined;

  const info = match?.[2]?.trim() ?? "";
  return {
    char: marker[0] as MarkdownFence["char"],
    length: marker.length,
    language: normalizeMarkdownFenceLanguage(info),
  };
}

function findMarkdownFence(lines: readonly string[], end: number): MarkdownFence | undefined {
  let fence: MarkdownFence | undefined;

  for (let index = 0; index < end; index += 1) {
    const line = lines[index] ?? "";
    if (!fence) {
      fence = parseMarkdownFence(line);
      continue;
    }
    if (isMarkdownFenceClose(line, fence)) {
      fence = undefined;
    }
  }

  return fence;
}

function isMarkdownFenceClose(line: string, fence: MarkdownFence): boolean {
  const marker = /^(?: {0,3})(`{3,}|~{3,})\s*$/.exec(line)?.[1] ?? "";
  return marker[0] === fence.char && marker.length >= fence.length;
}

function normalizeMarkdownFenceLanguage(languageInfo: string): string | undefined {
  const token = languageInfo
    .replace(/^[{.]+/, "")
    .replace(/[}\s].*$/, "")
    .toLowerCase();
  if (token.length === 0) return undefined;

  const alias = MARKDOWN_FENCE_LANGUAGE_ALIASES[token];
  return alias ?? getLanguageFromPath(`f.${token}`) ?? token;
}

const MARKDOWN_FENCE_LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
};

function styleMarkdownLine(line: string, theme: MarkdownTheme): string {
  if (/^(?: {0,3})([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return theme.hr(line);
  }

  if (/^(?: {0,3})#{1,6}(?:\s|$)/.test(line)) {
    return theme.heading(line);
  }

  const quoteMatch = /^(\s*> ?)(.*)$/.exec(line);
  if (quoteMatch) {
    const prefix = quoteMatch[1] ?? "";
    const content = quoteMatch[2] ?? "";
    return `${theme.quoteBorder(prefix)}${theme.quote(styleMarkdownInline(content, theme))}`;
  }

  const unorderedListMatch = /^(\s*)([-+*])(\s+)(.*)$/.exec(line);
  if (unorderedListMatch) {
    const indent = unorderedListMatch[1] ?? "";
    const bullet = unorderedListMatch[2] ?? "";
    const spacing = unorderedListMatch[3] ?? "";
    const content = unorderedListMatch[4] ?? "";
    return `${indent}${theme.listBullet(bullet)}${spacing}${styleMarkdownInline(content, theme)}`;
  }

  const orderedListMatch = /^(\s*)(\d+[.)])(\s+)(.*)$/.exec(line);
  if (orderedListMatch) {
    const indent = orderedListMatch[1] ?? "";
    const bullet = orderedListMatch[2] ?? "";
    const spacing = orderedListMatch[3] ?? "";
    const content = orderedListMatch[4] ?? "";
    return `${indent}${theme.listBullet(bullet)}${spacing}${styleMarkdownInline(content, theme)}`;
  }

  return styleMarkdownInline(line, theme);
}

function styleMarkdownInline(line: string, theme: MarkdownTheme): string {
  return line
    .replace(/`([^`]+)`/g, (value) => theme.code(value))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_value, text: string, url: string) =>
      `${theme.link(`[${text}]`)}${theme.linkUrl(`(${url})`)}`
    );
}

function sortEntries<T extends { name: string; isDirectory: boolean }>(
  entries: T[],
): T[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

assert.deepEqual(
  sortEntries([
    { name: "b.txt", isDirectory: false },
    { name: "a", isDirectory: true },
    { name: "a.txt", isDirectory: false },
  ]).map((entry) => entry.name),
  ["a", "a.txt", "b.txt"],
);
