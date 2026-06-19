import type { SettingItem } from "@earendil-works/pi-tui";

type PathDisplayer = {
  displayPath(fullPath: string, cwd: string): string;
};

export type FileContextPin = {
  kind: "file";
  fullPath: string;
};

export type RangeContextPin = {
  kind: "range";
  fullPath: string;
  startLine: number;
  endLine: number;
  snapshot: string;
};

export type ContextPin = FileContextPin | RangeContextPin;

export type PinManagerState = {
  nextTurnPins: ContextPin[];
};

export type PinnedContextView = {
  key: string;
  pin: ContextPin;
  displayPath: string;
  displayLabel: string;
};

export type PinnedFilesState = {
  nextTurn: PinnedContextView[];
};

export function describePinnedFiles(
  cwd: string,
  nextTurnPins: ReadonlyArray<ContextPin>,
  files: PathDisplayer,
): PinnedFilesState {
  const nextTurn = new Map<string, PinnedContextView>();

  for (const pin of nextTurnPins) {
    const view = describeContextPin(pin, cwd, files);
    nextTurn.set(view.key, view);
  }

  return {
    nextTurn: [...nextTurn.values()],
  };
}

export function buildPinnedFileContextText(
  cwd: string,
  nextTurnPins: ReadonlyArray<ContextPin>,
  files: PathDisplayer,
): string | undefined {
  const pinned = describePinnedFiles(cwd, nextTurnPins, files);
  if (pinned.nextTurn.length === 0) return undefined;

  const lines = [
    "## Pinned file context",
    "Treat these pinned files and snippets as high-priority context for this conversation. When relevant, read them before answering questions or making changes.",
  ];

  for (const { pin, displayLabel } of pinned.nextTurn) {
    if (pin.kind === "file") {
      lines.push(`- next turn file: ${displayLabel}`);
      continue;
    }

    lines.push(`- next turn snippet: ${displayLabel}`);
    lines.push("```");
    lines.push(formatSnapshot(pin));
    lines.push("```");
  }

  return lines.join("\n");
}

export function buildPinManagerItems(
  cwd: string,
  nextTurnPins: ReadonlyArray<ContextPin>,
  files: PathDisplayer,
): SettingItem[] {
  return describePinnedFiles(cwd, nextTurnPins, files).nextTurn.map((pin) => ({
    id: `next-turn:${pin.key}`,
    label: pin.displayLabel,
    currentValue: "keep",
    values: ["keep", "remove"],
  }));
}

export function describeContextPin(
  pin: ContextPin,
  cwd: string,
  files: PathDisplayer,
): PinnedContextView {
  const displayPath = files.displayPath(pin.fullPath, cwd);
  return {
    key: pinKey(pin),
    pin,
    displayPath,
    displayLabel: pin.kind === "file"
      ? displayPath
      : `${displayPath}:${pin.startLine}-${pin.endLine}`,
  };
}

export function pinKey(pin: ContextPin): string {
  return pin.kind === "file"
    ? `file:${pin.fullPath}`
    : `range:${pin.fullPath}:${pin.startLine}:${pin.endLine}`;
}

export function pinFullPath(pin: ContextPin): string {
  return pin.fullPath;
}

export function ensurePin(
  pins: ReadonlyArray<ContextPin>,
  nextPin: ContextPin,
): ContextPin[] {
  const key = pinKey(nextPin);
  const index = pins.findIndex((pin) => pinKey(pin) === key);
  if (index === -1) return [...pins, nextPin];

  const nextPins = [...pins];
  nextPins[index] = nextPin;
  return nextPins;
}

export function removeContextPin(
  pins: ReadonlyArray<ContextPin>,
  targetPin: ContextPin,
): ContextPin[] {
  const key = pinKey(targetPin);
  return pins.filter((pin) => pinKey(pin) !== key);
}

export function togglePinnedPin(
  pins: ReadonlyArray<ContextPin>,
  targetPin: ContextPin,
): ContextPin[] {
  const key = pinKey(targetPin);
  return pins.some((pin) => pinKey(pin) === key)
    ? removeContextPin(pins, targetPin)
    : ensurePin(pins, targetPin);
}

function formatSnapshot(pin: RangeContextPin): string {
  return pin.snapshot
    .split("\n")
    .map((line, index) => `${pin.startLine + index} | ${line}`)
    .join("\n");
}
