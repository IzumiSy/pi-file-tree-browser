import { statSync } from "node:fs";
import path from "node:path";

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
import { Type } from "typebox";

import {
  isWithin,
  normalizeBrowserResultRange,
  searchHitKey,
  type SearchHit,
} from "./browser-results";
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
let latestBrowserResultsByCwd:
  | {
    cwd: string;
    title: string;
    hits: SearchHit[];
  }
  | undefined;
let lastFileViewerStateByCwd:
  | { cwd: string; state: FileViewerState }
  | undefined;

type BrowserResultInput = {
  path: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
};

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" } as const;
    }

    const mode = parseFilesResultInputMode(event.text) ?? parseFilesInputMode(event.text);
    if (!mode) {
      return { action: "continue" } as const;
    }

    await handleFilesCommand(ctx, mode);
    return { action: "handled" } as const;
  });

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

  pi.registerTool({
    name: "set_file_browser_results",
    label: "Set File Browser Results",
    description: "Store a curated shortlist of file locations for inspection in /files-result",
    promptSnippet: "Add relevant file locations so the user can inspect them in the file browser",
    promptGuidelines: [
      "Use set_file_browser_results after narrowing a task to a short list of relevant files or line ranges.",
      "Use set_file_browser_results once near the end of a turn, not for incremental search dumps.",
      "Use set_file_browser_results when the user would benefit from inspecting or pinning candidate locations in /files-result.",
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short label for the stored result set" })),
      results: Type.Array(
        Type.Object({
          path: Type.String({ description: "Path relative to cwd or absolute within cwd" }),
          startLine: Type.Optional(Type.Integer({ minimum: 1 })),
          endLine: Type.Optional(Type.Integer({ minimum: 1 })),
          reason: Type.Optional(Type.String({ description: "Short reason shown in the result list" })),
        }),
        { minItems: 1, maxItems: 50 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const hits = normalizeBrowserResults(ctx.cwd, params.results);
      if (hits.length === 0) {
        clearBrowserResults(ctx.cwd);
        updateBrowserResultsWidget(ctx, getBrowserResults(ctx.cwd));
        return {
          content: [{ type: "text", text: "No valid results stored." }],
          details: { storedCount: 0 },
        };
      }

      latestBrowserResultsByCwd = {
        cwd: ctx.cwd,
        title: params.title?.trim() || "AI results",
        hits,
      };
      const browserResults = getBrowserResults(ctx.cwd);
      const editorPrefill = !!browserResults
        ? prefillFilesResultCommand(ctx)
        : "none";
      updateBrowserResultsWidget(ctx, browserResults);

      return {
        content: [{
          type: "text",
          text: editorPrefill === "prefilled"
            ? `Stored ${hits.length} results. Loaded /files-result into the editor.`
            : `Stored ${hits.length} results. Open with /files-result.`,
        }],
        details: {
          storedCount: hits.length,
          title: latestBrowserResultsByCwd.title,
          editorPrefill,
        },
      };
    },
  });

  pi.registerCommand("files", {
    description: "Open the file viewer overlay (/files)",
    handler: async (args, ctx) => {
      if (commandParts(args).length > 0) {
        ctx.ui.notify("Use /files-result or /files-result clear", "info");
        return;
      }
      await handleFilesCommand(ctx, "tree");
    },
  });

  pi.registerCommand("files-result", {
    description: "Open or clear the latest AI-provided shortlist (/files-result or /files-result clear)",
    handler: async (args, ctx) => {
      await handleFilesCommand(ctx, filesResultCommandMode(args));
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
  return commandParts(args)[0] === "clear";
}

function parseFilesInputMode(text: string): "tree" | undefined {
  return text.trim() === "/files" ? "tree" : undefined;
}

function parseFilesResultInputMode(text: string): "results" | "clear-results" | undefined {
  const trimmed = text.trim();
  if (trimmed === "/files-result") return "results";
  if (!trimmed.startsWith("/files-result ")) return undefined;
  return filesResultCommandMode(trimmed.slice("/files-result".length).trim());
}

function filesResultCommandMode(args: unknown): "results" | "clear-results" {
  const [first] = commandParts(args);
  if (first === "clear") return "clear-results";
  return "results";
}

function commandParts(args: unknown): string[] {
  return Array.isArray(args)
    ? args.filter((value): value is string => typeof value === "string")
    : typeof args === "string"
      ? args.trim().split(/\s+/).filter(Boolean)
      : [];
}

function getBrowserResults(cwd: string): { title: string; hits: SearchHit[] } | undefined {
  if (latestBrowserResultsByCwd?.cwd !== cwd) return undefined;
  return {
    title: latestBrowserResultsByCwd.title,
    hits: latestBrowserResultsByCwd.hits,
  };
}

function clearBrowserResults(cwd: string): boolean {
  if (latestBrowserResultsByCwd?.cwd !== cwd) return false;
  latestBrowserResultsByCwd = undefined;
  return true;
}

function normalizeBrowserResults(
  cwd: string,
  results: ReadonlyArray<BrowserResultInput>,
): SearchHit[] {
  const deduped = new Map<string, SearchHit>();

  for (const result of results) {
    const fullPath = path.resolve(cwd, result.path);
    if (!isWithin(fullPath, cwd)) continue;

    let isDirectory: boolean;
    try {
      isDirectory = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }

    const range = normalizeBrowserResultRange(result.startLine, result.endLine, !isDirectory);
    const hit: SearchHit = {
      fullPath,
      relativePath: files.displayPath(fullPath, cwd),
      score: 0,
      isDirectory,
      ...range,
      ...(result.reason?.trim() ? { reason: result.reason.trim() } : {}),
    };
    deduped.set(searchHitKey(hit), hit);
  }

  return [...deduped.values()];
}

async function handleFilesCommand(
  ctx: ExtensionContext,
  mode: "tree" | "results" | "clear-results",
): Promise<void> {
  if (mode === "clear-results") {
    if (!clearBrowserResults(ctx.cwd)) {
      ctx.ui.notify("No browser results", "info");
      return;
    }

    updateBrowserResultsWidget(ctx, getBrowserResults(ctx.cwd));
    ctx.ui.notify("Cleared browser results", "info");
    return;
  }

  if (ctx.mode !== "tui") {
    ctx.ui.notify("File browser is only available in TUI mode", "error");
    return;
  }

  const browserResults = mode === "results"
    ? getBrowserResults(ctx.cwd)
    : undefined;
  if (mode === "results" && !browserResults) {
    ctx.ui.notify("No browser results. Ask pi to add them first.", "info");
    return;
  }

  await openFileViewerOverlay(ctx, browserResults);
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
        ` ${theme.fg("muted", "Pinned context:")} ${theme.fg("accent", pinned.nextTurn.map((pin) => pin.displayLabel).join(", "))}`,
      ),
    ],
    invalidate(): void {},
  }));
}

function updateBrowserResultsWidget(
  ctx: ExtensionContext,
  browserResults: { title: string; hits: ReadonlyArray<SearchHit> } | undefined,
): void {
  if (!ctx.hasUI) return;
  if (!browserResults || browserResults.hits.length === 0) {
    ctx.ui.setWidget("files-browser-results", undefined);
    return;
  }

  ctx.ui.setWidget("files-browser-results", (_tui, theme) => ({
    render: (width: number) => [
      fit(
        width,
        ` ${theme.fg("muted", "Shortlist:")} ${theme.fg("accent", `${browserResults.title} (${browserResults.hits.length})`)} ${theme.fg("dim", "/files-result")}`,
      ),
    ],
    invalidate(): void {},
  }));
}

function prefillFilesResultCommand(
  ctx: ExtensionContext,
): "prefilled" | "kept-existing" | "none" {
  if (!ctx.hasUI || ctx.mode !== "tui") return "none";

  const current = ctx.ui.getEditorText().trim();
  if (current.length > 0) {
    return "kept-existing";
  }

  ctx.ui.setEditorText("/files-result");
  return "prefilled";
}

async function openFileViewerOverlay(
  ctx: ExtensionContext,
  browserResults?: { title: string; hits: ReadonlyArray<SearchHit> },
): Promise<boolean> {
  if (ctx.mode !== "tui") return false;

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
      if (browserResults) {
        overlay.openResults(browserResults.title, browserResults.hits);
      }
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

  return true;
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
