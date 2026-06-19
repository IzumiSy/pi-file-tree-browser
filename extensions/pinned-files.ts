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

export type PinScope = "session" | "next-turn";

export type PinnedFileView = {
  fullPath: string;
  displayPath: string;
};

export type PinnedFileDescriptor = PinnedFileView & {
  scopes: PinScope[];
};

export type PinnedFilesState = {
  session: PinnedFileView | undefined;
  nextTurn: PinnedFileView[];
  combined: PinnedFileDescriptor[];
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

export function describePinnedFiles(
  cwd: string,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
  files: PathDisplayer,
): PinnedFilesState {
  const session = sessionPath
    ? { fullPath: sessionPath, displayPath: files.displayPath(sessionPath, cwd) }
    : undefined;
  const nextTurn = nextTurnPaths.map((fullPath) => ({
    fullPath,
    displayPath: files.displayPath(fullPath, cwd),
  }));
  const combined = new Map<string, PinnedFileDescriptor>();

  if (session) {
    combined.set(session.fullPath, { ...session, scopes: ["session"] });
  }

  for (const pinned of nextTurn) {
    const existing = combined.get(pinned.fullPath);
    if (existing) {
      if (!existing.scopes.includes("next-turn")) {
        existing.scopes = [...existing.scopes, "next-turn"];
      }
      continue;
    }

    combined.set(pinned.fullPath, { ...pinned, scopes: ["next-turn"] });
  }

  return {
    session,
    nextTurn,
    combined: [...combined.values()],
  };
}

export function buildPinnedFileContextText(
  cwd: string,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
  files: PathDisplayer,
): string | undefined {
  const pinned = describePinnedFiles(cwd, sessionPath, nextTurnPaths, files);
  if (pinned.combined.length === 0) return undefined;

  const lines = pinned.combined.map(({ displayPath, scopes }) => {
    const scope = scopes.map(formatScope).join(" + ");
    return `- ${scope}: ${displayPath}`;
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
  const pinned = describePinnedFiles(cwd, sessionPath, nextTurnPaths, files);
  const items: SettingItem[] = [];

  for (const fullPath of pinned.nextTurn) {
    items.push({
      id: `next-turn:${fullPath.fullPath}`,
      label: fullPath.displayPath,
      currentValue: "keep",
      values: ["keep", "remove"],
    });
  }

  if (pinned.session) {
    items.push({
      id: `session:${pinned.session.fullPath}`,
      label: pinned.session.displayPath,
      currentValue: "keep",
      values: ["keep", "remove"],
    });
  }

  return items;
}

export function ensurePath(paths: ReadonlyArray<string>, fullPath: string): string[] {
  return paths.includes(fullPath) ? [...paths] : [...paths, fullPath];
}

export function removePinnedPath(paths: ReadonlyArray<string>, fullPath: string): string[] {
  return paths.filter((path) => path !== fullPath);
}

export function togglePinnedPath(paths: ReadonlyArray<string>, fullPath: string): string[] {
  return paths.includes(fullPath)
    ? removePinnedPath(paths, fullPath)
    : ensurePath(paths, fullPath);
}

export function toggleSessionPath(
  sessionPath: string | undefined,
  fullPath: string,
): string | undefined {
  return sessionPath === fullPath ? undefined : fullPath;
}

function formatScope(scope: PinScope): string {
  return scope === "next-turn" ? "next turn" : scope;
}
