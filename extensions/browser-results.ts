import path from "node:path";

export type SearchHit = {
  fullPath: string;
  relativePath: string;
  score: number;
  isDirectory: boolean;
  startLine?: number;
  endLine?: number;
  reason?: string;
};

export function searchHitKey(hit: SearchHit): string {
  return `${hit.fullPath}:${hit.startLine ?? ""}:${hit.endLine ?? ""}:${hit.isDirectory ? "dir" : "file"}`;
}

export function normalizeBrowserResultRange(
  startLine: number | undefined,
  endLine: number | undefined,
  allowRange: boolean,
): Partial<Pick<SearchHit, "startLine" | "endLine">> {
  if (!allowRange) return {};

  const start = normalizePositiveInteger(startLine);
  const end = normalizePositiveInteger(endLine);
  if (start === undefined) return {};
  if (end === undefined || end === start) return { startLine: start };

  return start < end
    ? { startLine: start, endLine: end }
    : { startLine: end, endLine: start };
}

export function isWithin(target: string, base: string): boolean {
  const relativePath = path.relative(base, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}
