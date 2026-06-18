import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

import { FileViewerOverlay, type FileViewerResult } from "./file-browser";
import { FileRepository, fit } from "./file-repository";

const files = new FileRepository();
const SESSION_CONTEXT_ENTRY = "files-session-context";
let pendingChatContextPaths: string[] = [];
let sessionChatContextPath: string | undefined;

type SessionContextEntry = {
  fullPath?: string;
};

type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
};

type PinManagerAction =
  | { kind: "remove-next-turn"; fullPath: string }
  | { kind: "remove-session"; fullPath: string };

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    sessionChatContextPath = readSessionContextPath(ctx.sessionManager.getEntries());
    updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const nextTurnPaths = pendingChatContextPaths;
    pendingChatContextPaths = [];
    updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);

    const pinnedContext = buildPinnedFileContextText(
      ctx.cwd,
      sessionChatContextPath,
      nextTurnPaths,
    );
    if (!pinnedContext) return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${pinnedContext}`,
    };
  });

  pi.registerCommand("files", {
    description: "Open a nerdtree-like file viewer overlay",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/files is only available in TUI mode", "error");
        return;
      }

      const result = await ctx.ui.custom<FileViewerResult>(
        (tui, theme, _kb, done) =>
          new FileViewerOverlay(
            ctx.cwd,
            tui,
            theme,
            files,
            pendingChatContextPaths,
            sessionChatContextPath,
            (fullPaths) => {
              pendingChatContextPaths = fullPaths;
              updateChatContextWidget(ctx, sessionChatContextPath, fullPaths);
            },
            done,
          ),
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 0,
          },
        },
      );

      if (result?.kind === "edit") {
        await openFileEditor(ctx, result.fullPath);
        return;
      }

      if (result?.kind === "session-pin") {
        const nextSessionPath =
          sessionChatContextPath === result.fullPath ? undefined : result.fullPath;
        sessionChatContextPath = nextSessionPath;
        pi.appendEntry(SESSION_CONTEXT_ENTRY, { fullPath: nextSessionPath });
        updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);
        ctx.ui.notify(
          nextSessionPath
            ? `Pinned in session: ${files.displayPath(nextSessionPath, ctx.cwd)}`
            : "Cleared session-pinned file",
          "info",
        );
      }
    },
  });

  pi.registerCommand("pins", {
    description: "Manage pinned file context",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/pins is only available in TUI mode", "error");
        return;
      }

      if (!sessionChatContextPath && pendingChatContextPaths.length === 0) {
        ctx.ui.notify("No pinned files", "info");
        return;
      }

      while (sessionChatContextPath || pendingChatContextPaths.length > 0) {
        const action = await showPinManagerDialog(ctx);
        if (!action) return;

        switch (action.kind) {
          case "remove-next-turn":
            pendingChatContextPaths = pendingChatContextPaths.filter(
              (fullPath) => fullPath !== action.fullPath,
            );
            updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);
            ctx.ui.notify(
              `Unpinned next-turn file: ${files.displayPath(action.fullPath, ctx.cwd)}`,
              "info",
            );
            break;
          case "remove-session":
            sessionChatContextPath = undefined;
            pi.appendEntry(SESSION_CONTEXT_ENTRY, { fullPath: undefined });
            updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);
            ctx.ui.notify(
              `Cleared session pin: ${files.displayPath(action.fullPath, ctx.cwd)}`,
              "info",
            );
            break;
        }
      }
    },
  });
}

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
): SelectItem[] {
  const items: SelectItem[] = [];

  for (const fullPath of nextTurnPaths) {
    items.push({
      value: `next-turn:${fullPath}`,
      label: files.displayPath(fullPath, cwd),
      description: "Enter to remove",
    });
  }

  if (sessionPath) {
    items.push({
      value: `session:${sessionPath}`,
      label: files.displayPath(sessionPath, cwd),
      description: "Enter to remove",
    });
  }

  return items;
}

function parsePinManagerAction(value: string): PinManagerAction | undefined {
  if (value.startsWith("next-turn:")) {
    return { kind: "remove-next-turn", fullPath: value.slice("next-turn:".length) };
  }

  if (value.startsWith("session:")) {
    return { kind: "remove-session", fullPath: value.slice("session:".length) };
  }

  return undefined;
}

async function showPinManagerDialog(
  ctx: ExtensionContext,
): Promise<PinManagerAction | undefined> {
  const items = buildPinManagerItems(
    ctx.cwd,
    sessionChatContextPath,
    pendingChatContextPaths,
  );

  if (items.length === 0) return undefined;

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Remove pinned file")), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 8), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter remove • esc/q cancel"), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, "q")) {
          done(null);
          return;
        }
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ? parsePinManagerAction(result) : undefined;
}

function updateChatContextWidget(
  ctx: ExtensionContext,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
): void {
  if (!ctx.hasUI) return;

  if (!sessionPath && nextTurnPaths.length === 0) {
    ctx.ui.setWidget("files-chat-context", undefined);
    return;
  }

  ctx.ui.setWidget("files-chat-context", (_tui, theme) => ({
    render: (width: number) => {
      const lines: string[] = [];

      if (sessionPath) {
        lines.push(
          fitWidgetLine(
            width,
            `${theme.fg("muted", "Pinned session file:")} ${theme.fg("accent", files.displayPath(sessionPath, ctx.cwd))}`,
          ),
        );
      }

      if (nextTurnPaths.length > 0) {
        lines.push(
          fitWidgetLine(
            width,
            `${theme.fg("muted", "Pinned next-turn files:")} ${theme.fg("accent", nextTurnPaths.map((fullPath) => files.displayPath(fullPath, ctx.cwd)).join(", "))}`,
          ),
        );
      }

      return lines;
    },
    invalidate(): void {},
  }));
}

async function openFileEditor(
  ctx: ExtensionContext,
  fullPath: string,
): Promise<void> {
  try {
    const editable = files.readEditableText(fullPath);
    if (editable.kind === "binary") {
      ctx.ui.notify("Binary files cannot be opened in the editor", "error");
      return;
    }

    const current = editable.text;
    const edited = await ctx.ui.editor(
      `Edit: ${files.displayPath(fullPath, ctx.cwd)}`,
      current,
    );

    if (edited === undefined || edited === current) return;

    files.writeText(fullPath, edited);
    ctx.ui.notify(`Saved: ${files.displayPath(fullPath, ctx.cwd)}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`editor error: ${message}`, "error");
  }
}

function fitWidgetLine(width: number, text: string): string {
  return fit(width, text);
}
