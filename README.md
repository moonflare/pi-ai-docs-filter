# pi-ai-docs-filter

A [Pi](https://pi.dev) extension that keeps AI-assistant documentation files out of context by default, with an interactive picker to opt individual files in whenever you need them.

Many projects accumulate multiple AI assistant config files — for Cursor, Copilot, Windsurf, Cline, Claude Code, and others. Pi picks some of these up automatically and you might not want all of them polluting the context window on every turn. This extension filters them out silently and lets you choose exactly which ones matter for the task at hand.

## What it does

- **Filters everything by default.** All discovered AI doc files are excluded from Pi's context.
- **Pi auto-loaded files** (`AGENTS.md`, `CLAUDE.md`) are actively stripped from the system prompt.
- **Other files** are simply never injected.
- **`/ai-docs`** opens an interactive overlay where you toggle files on/off with `space`. Your choices persist for the session.
- **Status bar** shows `docs:N` when N files are enabled, or `docs:off` when all are filtered.

## Supported file patterns

| File | Tool |
|------|------|
| `AGENTS.md` | Pi / Claude Code *(auto-loaded — stripped when off)* |
| `CLAUDE.md` | Pi / Claude Code *(auto-loaded — stripped when off)* |
| `ARCHITECTURE.md` | Project doc |
| `SECURITY.md` | Project doc |
| `CONTRIBUTING.md` | Project doc |
| `DEVELOPMENT.md` | Project doc |
| `.cursorrules` | Cursor (legacy) |
| `.cursor/rules/*.mdc` | Cursor (new-style, each file listed individually) |
| `.github/copilot-instructions.md` | GitHub Copilot |
| `.windsurfrules` | Windsurf |
| `.clinerules` | Cline / RooCode |

Only files that **actually exist** in the project are shown in the picker. The extension is a no-op in projects that have none of these files.

## Install

### Global (personal use)

```bash
pi install git:github.com/moonflare/pi-ai-docs-filter
```

### Project-wide (shared with your team)

Add to `.pi/settings.json` in your repo and commit it. Pi installs missing packages automatically on startup.

```json
{
  "packages": [
    "git:github.com/moonflare/pi-ai-docs-filter"
  ]
}
```

> Teammates just need Pi installed. No extra steps.

### Try it without installing

```bash
pi -e git:github.com/moonflare/pi-ai-docs-filter
```

## Configuration

Choices are saved to `.pi/ai-docs.json` in the project root the moment you confirm the picker. The file is plain JSON:

```json
{
  "enabled": ["AGENTS.md", "SECURITY.md"]
}
```

- **Persists across sessions** — starting a new session (`/new`) keeps your selections.
- **Per-project** — each project has its own `.pi/ai-docs.json`, completely independent.
- **Committable** — check it in to share defaults with teammates. Or add it to `.gitignore` for personal-only settings.

## Usage

Once installed, the extension loads automatically.

| Action | What happens |
|--------|-------------|
| Start Pi normally | All AI doc files are filtered from context |
| `/ai-docs` | Open the file picker |
| `↑` / `↓` (or `k` / `j`) | Navigate the list |
| `space` | Toggle a file on or off |
| `enter` | Confirm and close |
| `esc` | Cancel without changes |

Enabled files stay on for the rest of the session and are restored if you `/reload`.

## Development

```bash
git clone https://github.com/moonflare/pi-ai-docs-filter
cd pi-ai-docs-filter

# Load it in a project for testing (no install)
pi -e ./extensions/ai-docs-filter.ts
```

To add support for a new AI assistant file, add an entry to `STATIC_PATTERNS` in `extensions/ai-docs-filter.ts`.

## License

MIT
