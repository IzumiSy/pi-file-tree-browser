import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

const PREVIEW_HIGHLIGHT_BUFFER_LINES = 40;

export class FileRepository {
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

    const cached = preview.renderedWindow;
    if (cached && start >= cached.start && end <= cached.end) {
      return cached.lines.slice(start - cached.start, end - cached.start);
    }

    const bufferedStart = Math.max(0, start - PREVIEW_HIGHLIGHT_BUFFER_LINES);
    const bufferedEnd = Math.min(
      preview.fallbackLines.length,
      end + PREVIEW_HIGHLIGHT_BUFFER_LINES,
    );
    const language = getLanguageFromPath(fullPath);
    const lines = highlightCode(
      preview.fallbackLines.slice(bufferedStart, bufferedEnd).join("\n"),
      language,
    ).map(ensureForegroundReset);

    preview.renderedWindow = {
      start: bufferedStart,
      end: bufferedEnd,
      lines,
    };
    return lines.slice(start - bufferedStart, end - bufferedStart);
  }

  readEditableText(fullPath: string): { kind: "binary" } | { kind: "text"; text: string } {
    const buffer = readFileSync(fullPath);
    if (buffer.includes(0)) return { kind: "binary" };
    return { kind: "text", text: buffer.toString("utf8") };
  }

  writeText(fullPath: string, text: string): void {
    writeFileSync(fullPath, text, "utf8");
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
}

export function fit(width: number, text: string): string {
  const clipped = truncateToWidth(text, width, "", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function ensureForegroundReset(line: string): string {
  return line.endsWith(FG_RESET) ? line : `${line}${FG_RESET}`;
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
