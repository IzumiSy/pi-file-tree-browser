import type { SettingItem } from "@earendil-works/pi-tui";

export const SESSION_CONTEXT_ENTRY = "files-session-context";

type PathDisplayer = {
  displayPath(fullPath: string, cwd: string): string;
};

export type SessionContextEntry = {
  fullPath?: string;
};

export type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export type PinManagerState = {
  sessionPath: string | undefined;
  nextTurnPaths: string[];
};

export function readSessionContextPath(
  entries: ReadonlyArray<SessionEntryLike>,
): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.type !== "custom" || entry.customType !== SESSION_CONTEXT_ENTRY) continue;

    const data = entry.data;
    if (!data || typeof data !== "object") return undefined;

    const fullPath = (data as SessionContextEntry).fullPath;
    return typeof fullPath === "string" && fullPath.length > 0 ? fullPath : undefined;
  }

  return undefined;
}

export function buildPinnedFileContextText(
  cwd: string,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
  files: PathDisplayer,
): string | undefined {
  const labels = new Map<string, string[]>();

  if (sessionPath) labels.set(sessionPath, ["session"]);
  for (const nextTurnPath of nextTurnPaths) {
    labels.set(nextTurnPath, [...(labels.get(nextTurnPath) ?? []), "next turn"]);
  }

  if (labels.size === 0) return undefined;

  const lines = [...labels.entries()].map(([fullPath, scopes]) => {
    const scope = scopes.join(" + ");
    return `- ${scope}: ${files.displayPath(fullPath, cwd)}`;
  });

  return [
    "## Pinned file context",
    "Treat these pinned files as high-priority context for this conversation. When relevant, read them before answering questions or making changes.",
    ...lines,
  ].join("\n");
}

export function buildPinManagerItems(
  cwd: string,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
  files: PathDisplayer,
): SettingItem[] {
  const items: SettingItem[] = [];

  for (const fullPath of nextTurnPaths) {
    items.push({
      id: `next-turn:${fullPath}`,
      label: files.displayPath(fullPath, cwd),
      currentValue: "keep",
      values: ["keep", "remove"],
    });
  }

  if (sessionPath) {
    items.push({
      id: `session:${sessionPath}`,
      label: files.displayPath(sessionPath, cwd),
      currentValue: "keep",
      values: ["keep", "remove"],
    });
  }

  return items;
}

export function ensurePath(paths: ReadonlyArray<string>, fullPath: string): string[] {
  return paths.includes(fullPath) ? [...paths] : [...paths, fullPath];
}
