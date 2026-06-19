# pi-file-tree-browser

A pi TUI extension that adds a file tree browser and context pinning.

## Features

- Open a nerdtree-like file browser with `/files`
- Navigate directories, preview files, and make quick edits inside the TUI
- Fuzzy-search Git-tracked files
- Pin entire files or line ranges and pass them as high-priority context to the next agent turn
- Review or remove pins with `/pins`, or clear everything with `/pins clear`

## Install

```bash
pi install git:github.com/IzumiSy/pi-file-tree-browser
```

## Usage

This extension is intended for TUI mode.

### `/files`

Opens the file browser.

Main controls:

- `j` / `k`, `↑` / `↓`: Move
- `l` / `→`: Open directory / preview file
- `h` / `←`: Go to parent directory / close preview
- `Enter`: Open file in the editor
- `/`: Search files, or search inside the previewed file
- `s`: Pin the current file or selected preview range
- `Ctrl+S`: Pin the whole file
- `v`: Mark the start/end of a preview range
- `?`: Show help

### How pinning works

Pins are a lightweight way to tell pi, "this file or snippet matters for my next message."

- Pins are **next-turn only**. They are attached to the next agent turn, then cleared automatically.
- A **file pin** marks an entire file as important context.
- A **range pin** captures a specific line range from the preview and includes that snippet as high-priority context.
- Use **`Ctrl+S`** to pin the whole file immediately.
- Use **`v`** to mark the start of a range, move the cursor, press **`v`** again to mark the end, then press **`s`** to pin just that selection.
- This is useful when you want the agent to focus on one function, one error-producing block, or a small relevant snippet instead of a whole file.

### `/pins`

Shows the pins currently queued for the next turn, so you can review and remove them before sending your next message.

- `/pins`: open the pin manager
- `/pins clear`: remove all queued pins

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md)
