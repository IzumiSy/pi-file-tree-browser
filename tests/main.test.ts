import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import setupExtension from "../extension/main";

describe("set_file_browser_results", () => {
  it("keeps the widget visible when /files-result is prefilling the editor", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-file-browser-"));

    try {
      writeFileSync(path.join(cwd, "sample.ts"), "export {};\n");

      let editorText = "";
      let browserResultsWidget: unknown;
      const tools = new Map<string, any>();

      setupExtension({
        on() {},
        registerTool(tool: any) {
          tools.set(tool.name, tool);
        },
        registerCommand() {},
      } as any);

      const tool = tools.get("set_file_browser_results");
      expect(tool).toBeTruthy();

      const result = await tool.execute(
        "tool-call",
        {
          title: "Sample results",
          results: [{ path: "sample.ts" }],
        },
        undefined,
        () => {},
        {
          cwd,
          hasUI: true,
          mode: "tui",
          ui: {
            getEditorText() {
              return editorText;
            },
            setEditorText(text: string) {
              editorText = text;
            },
            setWidget(key: string, widget: unknown) {
              if (key === "files-browser-results") {
                browserResultsWidget = widget;
              }
            },
          },
        } as any,
      );

      expect(editorText).toBe("/files-result");
      expect(browserResultsWidget).toBeTypeOf("function");
      expect(result.content[0]?.text).toContain("Loaded /files-result into the editor.");

      const widget = (browserResultsWidget as any)(
        undefined,
        {
          fg: (_color: string, text: string) => text,
        },
      );
      expect(widget.render(80).join("\n")).toContain("Sample results (1)");
      expect(widget.render(80).join("\n")).toContain("/files-result");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
