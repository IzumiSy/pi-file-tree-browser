import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

import { FileViewerOverlay, type FileViewerResult } from "./file-browser";
import { FileRepository } from "./file-repository";
import {
  buildPinManagerItems,
  buildPinnedFileContextText,
  describePinnedFiles,
  ensurePath,
  removePinnedPath,
  type PinManagerState,
  readSessionContextPath,
  SESSION_CONTEXT_ENTRY,
  toggleSessionPath,
} from "./pinned-files";
import { fit } from "./text-layout";

const files = new FileRepository();
let pendingChatContextPaths: string[] = [];
let sessionChatContextPath: string | undefined;

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
      files,
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
        const nextSessionPath = toggleSessionPath(
          sessionChatContextPath,
          result.fullPath,
        );
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

      const nextState = await showPinManagerDialog(ctx);
      if (!nextState) return;

      pendingChatContextPaths = nextState.nextTurnPaths;
      sessionChatContextPath = nextState.sessionPath;
      pi.appendEntry(SESSION_CONTEXT_ENTRY, { fullPath: sessionChatContextPath });
      updateChatContextWidget(ctx, sessionChatContextPath, pendingChatContextPaths);
      ctx.ui.notify("Updated pinned files", "info");
    },
  });
}

async function showPinManagerDialog(
  ctx: ExtensionContext,
): Promise<PinManagerState | undefined> {
  let sessionPath = sessionChatContextPath;
  let nextTurnPaths = [...pendingChatContextPaths];
  const items = buildPinManagerItems(ctx.cwd, sessionPath, nextTurnPaths, files);

  if (items.length === 0) return undefined;

  return ctx.ui.custom<PinManagerState | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Pinned files")), 1, 0));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 10),
      getSettingsListTheme(),
      (id, newValue) => {
        if (id.startsWith("next-turn:")) {
          const fullPath = id.slice("next-turn:".length);
          nextTurnPaths = newValue === "keep"
            ? ensurePath(nextTurnPaths, fullPath)
            : removePinnedPath(nextTurnPaths, fullPath);
          return;
        }

        if (id.startsWith("session:")) {
          const fullPath = id.slice("session:".length);
          sessionPath = newValue === "keep" ? fullPath : undefined;
        }
      },
      () => {
        done({ sessionPath, nextTurnPaths });
      },
    );

    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter keep/remove • esc/q done"), 1, 0));
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
          done({ sessionPath, nextTurnPaths });
          return;
        }
        if (matchesKey(data, "left") || matchesKey(data, "right")) {
          return;
        }
        if (matchesKey(data, "j")) {
          settingsList.handleInput("\x1b[B");
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "k")) {
          settingsList.handleInput("\x1b[A");
          tui.requestRender();
          return;
        }
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function updateChatContextWidget(
  ctx: ExtensionContext,
  sessionPath: string | undefined,
  nextTurnPaths: ReadonlyArray<string>,
): void {
  if (!ctx.hasUI) return;

  const pinned = describePinnedFiles(ctx.cwd, sessionPath, nextTurnPaths, files);
  if (!pinned.session && pinned.nextTurn.length === 0) {
    ctx.ui.setWidget("files-chat-context", undefined);
    return;
  }

  ctx.ui.setWidget("files-chat-context", (_tui, theme) => ({
    render: (width: number) => {
      const lines: string[] = [];

      if (pinned.session) {
        lines.push(
          fit(
            width,
            `${theme.fg("muted", "Pinned session file:")} ${theme.fg("accent", pinned.session.displayPath)}`,
          ),
        );
      }

      if (pinned.nextTurn.length > 0) {
        lines.push(
          fit(
            width,
            `${theme.fg("muted", "Pinned next-turn files:")} ${theme.fg("accent", pinned.nextTurn.map((fullPath) => fullPath.displayPath).join(", "))}`,
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
