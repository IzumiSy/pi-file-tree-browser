import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { FileViewerOverlay, type FileViewerResult } from "./file-browser";
import { FileRepository, fit } from "./file-repository";

const files = new FileRepository();
let pendingChatContextPath: string | undefined;

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    if (!pendingChatContextPath) return;

    const fullPath = pendingChatContextPath;
    pendingChatContextPath = undefined;
    updateChatContextWidget(ctx, undefined);

    return {
      systemPrompt: `${event.systemPrompt}\n\n## Pinned file context\nThe user pinned this file from the /files browser for this turn only. Treat it as high-priority context for this conversation. When relevant, read it first before answering questions or making changes.\n- ${files.displayPath(fullPath, ctx.cwd)}`,
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
            pendingChatContextPath,
            (fullPath) => {
              if (pendingChatContextPath === fullPath) return;

              pendingChatContextPath = fullPath;
              updateChatContextWidget(ctx, fullPath);
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
      }
    },
  });
}

function updateChatContextWidget(
  ctx: ExtensionContext,
  fullPath: string | undefined,
): void {
  if (!ctx.hasUI) return;

  if (!fullPath) {
    ctx.ui.setWidget("files-chat-context", undefined);
    return;
  }

  const filePath = files.displayPath(fullPath, ctx.cwd);
  ctx.ui.setWidget("files-chat-context", (_tui, theme) => ({
    render: (width: number) => [
      fitWidgetLine(
        width,
        `${theme.fg("muted", "Pinned next-turn file:")} ${theme.fg("accent", filePath)}`,
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

function fitWidgetLine(width: number, text: string): string {
  return fit(width, text);
}

