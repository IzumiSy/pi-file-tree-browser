import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fit(width: number, text: string): string {
  const clipped = truncateToWidth(text, width, "", true);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
