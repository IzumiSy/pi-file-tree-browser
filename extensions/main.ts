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

import {
  FileViewerOverlay,
  type FileViewerResult,
  type FileViewerState,
} from "./file-browser";
import { FileRepository } from "./file-repository";
import {
  buildPinManagerItems,
  buildPinnedFileContextText,
  describePinnedFiles,
  pinKey,
  type ContextPin,
  type PinManagerState,
} from "./pinned-files";
import { fit } from "./text-layout";

const files = new FileRepository();
let pendingChatContextPins: ContextPin[] = [];
let lastFileViewerStateByCwd:
  | { cwd: string; state: FileViewerState }
  | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const nextTurnPins = pendingChatContextPins;
    pendingChatContextPins = [];
    updateChatContextWidget(ctx, pendingChatContextPins);

    const pinnedContext = buildPinnedFileContextText(
      ctx.cwd,
      nextTurnPins,
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
        (tui, theme, _kb, done) => {
          const overlay = new FileViewerOverlay(
            ctx.cwd,
            tui,
            theme,
            files,
            pendingChatContextPins,
            (pins) => {
              pendingChatContextPins = pins;
              updateChatContextWidget(ctx, pins);
            },
            done,
          );
          overlay.restoreState(
            lastFileViewerStateByCwd?.cwd === ctx.cwd
              ? lastFileViewerStateByCwd.state
              : undefined,
          );
          return overlay;
        },
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

      if (result) {
        lastFileViewerStateByCwd = { cwd: ctx.cwd, state: result.state };
      }

      if (result?.kind === "edit") {
        await openFileEditor(ctx, result.fullPath);
      }
    },
  });

  pi.registerCommand("pins", {
    description: "Manage pinned file context (/pins or /pins clear)",
    handler: async (args, ctx) => {
      if (isClearPinsCommand(args)) {
        if (pendingChatContextPins.length === 0) {
          ctx.ui.notify("No pinned context", "info");
          return;
        }

        pendingChatContextPins = [];
        updateChatContextWidget(ctx, pendingChatContextPins);
        ctx.ui.notify("Cleared pinned context", "info");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/pins is only available in TUI mode", "error");
        return;
      }

      if (pendingChatContextPins.length === 0) {
        ctx.ui.notify("No pinned context", "info");
        return;
      }

      const nextState = await showPinManagerDialog(ctx);
      if (!nextState) return;

      pendingChatContextPins = nextState.nextTurnPins;
      updateChatContextWidget(ctx, pendingChatContextPins);
      ctx.ui.notify("Updated pinned context", "info");
    },
  });
}

async function showPinManagerDialog(
  ctx: ExtensionContext,
): Promise<PinManagerState | undefined> {
  let nextTurnPins = [...pendingChatContextPins];
  const items = buildPinManagerItems(ctx.cwd, nextTurnPins, files);

  if (items.length === 0) return undefined;

  return ctx.ui.custom<PinManagerState | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Pinned context")), 1, 0));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 10),
      getSettingsListTheme(),
      (id, newValue) => {
        if (newValue !== "remove") return;
        if (!id.startsWith("next-turn:")) return;

        const key = id.slice("next-turn:".length);
        nextTurnPins = nextTurnPins.filter((pin) => pinKey(pin) !== key);
      },
      () => {
        done({ nextTurnPins });
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
          done({ nextTurnPins });
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

function isClearPinsCommand(args: unknown): boolean {
  const parts = Array.isArray(args)
    ? args.filter((value): value is string => typeof value === "string")
    : typeof args === "string"
      ? args.trim().split(/\s+/).filter(Boolean)
      : [];
  return parts[0] === "clear";
}

function updateChatContextWidget(
  ctx: ExtensionContext,
  nextTurnPins: ReadonlyArray<ContextPin>,
): void {
  if (!ctx.hasUI) return;

  const pinned = describePinnedFiles(ctx.cwd, nextTurnPins, files);
  if (pinned.nextTurn.length === 0) {
    ctx.ui.setWidget("files-chat-context", undefined);
    return;
  }

  ctx.ui.setWidget("files-chat-context", (_tui, theme) => ({
    render: (width: number) => [
      fit(
        width,
        `${theme.fg("muted", "Pinned context:")} ${theme.fg("accent", pinned.nextTurn.map((pin) => pin.displayLabel).join(", "))}`,
      ),
    ],
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
