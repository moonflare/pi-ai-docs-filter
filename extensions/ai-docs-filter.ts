/**
 * AI Docs Filter — Pi Extension
 *
 * Discovers common AI-assistant documentation files in your project and
 * keeps them out of Pi's context by default. Use /ai-docs to toggle
 * individual files on whenever you need them.
 *
 * Supports:
 *   Pi / Claude Code  — AGENTS.md, CLAUDE.md (auto-loaded; stripped when off)
 *   Cursor            — .cursorrules, .cursor/rules/*.mdc
 *   GitHub Copilot    — .github/copilot-instructions.md
 *   Windsurf          — .windsurfrules
 *   Cline / RooCode   — .clinerules
 *   Common project docs — ARCHITECTURE.md, SECURITY.md, CONTRIBUTING.md, DEVELOPMENT.md
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─── File catalogue ───────────────────────────────────────────────────────────

interface FileEntry {
  /** Relative path from project root. */
  path: string;
  /** Display name shown in the picker. */
  label: string;
  /**
   * true = Pi auto-loads this file into the system prompt.
   * The extension must strip the section from the prompt when it is disabled.
   */
  autoLoaded: boolean;
}

/**
 * Static (single-file) patterns. These are checked with existsSync.
 * autoLoaded is inferred from AUTO_LOADED_BASENAMES.
 */
const STATIC_PATTERNS: Omit<FileEntry, "autoLoaded">[] = [
  // ── Pi / Claude Code ────────────────────────────────────────────────────────
  { path: "AGENTS.md",                       label: "AGENTS.md" },
  { path: "CLAUDE.md",                       label: "CLAUDE.md" },
  // ── Common project docs ──────────────────────────────────────────────────────
  { path: "ARCHITECTURE.md",                 label: "ARCHITECTURE.md" },
  { path: "SECURITY.md",                     label: "SECURITY.md" },
  { path: "CONTRIBUTING.md",                 label: "CONTRIBUTING.md" },
  { path: "DEVELOPMENT.md",                  label: "DEVELOPMENT.md" },
  // ── AI coding assistants ─────────────────────────────────────────────────────
  { path: ".cursorrules",                    label: ".cursorrules  ·  Cursor (legacy)" },
  { path: ".github/copilot-instructions.md", label: ".github/copilot-instructions.md  ·  Copilot" },
  { path: ".windsurfrules",                  label: ".windsurfrules  ·  Windsurf" },
  { path: ".clinerules",                     label: ".clinerules  ·  Cline / RooCode" },
];

/**
 * Basenames that Pi auto-loads into the system prompt.
 * We need to actively strip these when they are disabled.
 */
const AUTO_LOADED_BASENAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Return all managed files that exist in `cwd`.
 * Also scans `.cursor/rules/` for individual rule files (.mdc / .md).
 */
function discoverFiles(cwd: string): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const p of STATIC_PATTERNS) {
    if (existsSync(resolve(cwd, p.path))) {
      entries.push({ ...p, autoLoaded: AUTO_LOADED_BASENAMES.has(basename(p.path)) });
    }
  }

  // Cursor new-style rules: .cursor/rules/*.{mdc,md}
  const cursorRulesDir = resolve(cwd, ".cursor/rules");
  if (existsSync(cursorRulesDir)) {
    try {
      const files = readdirSync(cursorRulesDir)
        .filter((f) => f.endsWith(".mdc") || f.endsWith(".md"))
        .sort();
      for (const f of files) {
        const rel = `.cursor/rules/${f}`;
        if (existsSync(resolve(cwd, rel))) {
          entries.push({ path: rel, label: `${rel}  ·  Cursor`, autoLoaded: false });
        }
      }
    } catch {
      // Unreadable directory — skip silently
    }
  }

  return entries;
}

// ─── System-prompt helpers ────────────────────────────────────────────────────

function readFileSafe(cwd: string, path: string): string | null {
  const full = resolve(cwd, path);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Strip one context-file section from the system prompt.
 *
 * Pi formats context files in two ways depending on whether a custom prompt is
 * active:
 *
 *   Default format:
 *     ## {filePath}\n\n{content}\n\n
 *
 *   Custom-prompt format:
 *     <project_instructions path="{filePath}">\n{content}\n</project_instructions>\n\n
 */
function stripSection(prompt: string, filePath: string, content: string): string {
  const defaultSection = `## ${filePath}\n\n${content}\n\n`;
  if (prompt.includes(defaultSection)) {
    return prompt.replace(defaultSection, "");
  }
  const customSection = `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
  if (prompt.includes(customSection)) {
    return prompt.replace(customSection, "");
  }
  return prompt;
}

/**
 * Remove the empty "# Project Context" or "<project_context>" wrapper that Pi
 * leaves behind when all its child sections have been stripped.
 */
function removeEmptyContextWrapper(prompt: string): string {
  // Default wrapper — nothing remaining before the next section / metadata
  prompt = prompt.replace(
    /\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n(?=\n|Current date)/,
    "\n\n",
  );
  // Custom-prompt wrapper
  prompt = prompt.replace(
    /\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n\n?<\/project_context>\n/,
    "",
  );
  return prompt;
}

/**
 * True when `contextFilePath` (possibly absolute) maps to `managedPath`
 * (relative).  Handles both Unix and Windows separators.
 *
 * Examples:
 *   "/repo/AGENTS.md"          , "AGENTS.md"                  → true
 *   "/repo/.cursor/rules/x.mdc", ".cursor/rules/x.mdc"        → true
 */
function matchesFile(contextFilePath: string, managedPath: string): boolean {
  const norm = contextFilePath.replace(/\\/g, "/");
  return norm === managedPath || norm.endsWith("/" + managedPath);
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function aiDocsFilter(pi: ExtensionAPI) {
  /** Which managed files the user has opted into (default: none = all filtered). */
  let enabledFiles = new Set<string>();

  /** Cached list of files that exist in the project. Refreshed on session start
   *  and each time the picker is opened. */
  let knownFiles: FileEntry[] = [];

  // ── Status bar ──────────────────────────────────────────────────────────────

  function updateStatus(ctx: ExtensionContext) {
    if (enabledFiles.size > 0) {
      ctx.ui.setStatus("ai-docs", ctx.ui.theme.fg("accent", `docs:${enabledFiles.size}`));
    } else {
      ctx.ui.setStatus("ai-docs", ctx.ui.theme.fg("dim", "docs:off"));
    }
  }

  // ── Interactive picker ──────────────────────────────────────────────────────

  async function showPicker(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      ctx.ui.notify("ai-docs: picker requires interactive mode", "warning");
      return;
    }

    // Refresh discovery so the list reflects the current project state
    knownFiles = discoverFiles(ctx.cwd);

    if (knownFiles.length === 0) {
      ctx.ui.notify("ai-docs: no AI documentation files found in this project", "warning");
      return;
    }

    let cursor = 0;
    const pending = new Set(enabledFiles);

    const result = await ctx.ui.custom<Set<string> | null>(
      (tui, theme, _kb, done) => ({
        render(_width: number): string[] {
          const lines: string[] = [];

          lines.push(theme.bold(theme.fg("accent", "  AI Docs Context Filter  ")));
          lines.push(theme.fg("dim", "  Choose which files to include in Pi's context"));
          lines.push("");

          for (let i = 0; i < knownFiles.length; i++) {
            const { path: file, label, autoLoaded } = knownFiles[i];
            const on = pending.has(file);
            const isCursor = i === cursor;
            const autoTag = autoLoaded ? theme.fg("dim", "  ↑ auto-loaded by Pi") : "";

            const pointer = isCursor ? theme.fg("accent", "▶") : " ";
            const check = on ? theme.fg("accent", "[✓]") : theme.fg("dim", "[ ]");
            const lbl = isCursor ? theme.fg("accent", label) : on ? label : theme.fg("dim", label);

            lines.push(`  ${pointer} ${check} ${lbl}${autoTag}`);
          }

          lines.push("");
          lines.push(theme.fg("dim", "  ↑↓  navigate    space  toggle    enter  confirm    esc  cancel"));
          return lines;
        },

        invalidate() {},

        handleInput(data: string) {
          if (data === "\r" || data === "\n") {
            done(new Set(pending));
          } else if (data === "\x1b") {
            done(null);
          } else if (data === " ") {
            const file = knownFiles[cursor].path;
            if (pending.has(file)) pending.delete(file);
            else pending.add(file);
            tui.requestRender();
          } else if (data === "\x1b[A" || data === "k") {
            cursor = Math.max(0, cursor - 1);
            tui.requestRender();
          } else if (data === "\x1b[B" || data === "j") {
            cursor = Math.min(knownFiles.length - 1, cursor + 1);
            tui.requestRender();
          }
        },
      }),
      { overlay: true },
    );

    if (result === null) return; // cancelled

    enabledFiles = result;
    pi.appendEntry("ai-docs-state", { enabledFiles: Array.from(enabledFiles) });
    updateStatus(ctx);

    const n = enabledFiles.size;
    ctx.ui.notify(
      n > 0 ? `AI docs: ${n} file(s) enabled in context` : "AI docs: all files filtered from context",
      "info",
    );
  }

  // ── /ai-docs command ────────────────────────────────────────────────────────

  pi.registerCommand("ai-docs", {
    description: "Toggle which AI documentation files are included in Pi's context",
    handler: async (_args, ctx) => showPicker(ctx),
  });

  // ── Filter & inject on every agent turn ─────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const contextFiles: Array<{ path: string; content: string }> =
      event.systemPromptOptions.contextFiles ?? [];

    let prompt = event.systemPrompt;

    // ── Step 1: strip disabled auto-loaded files ─────────────────────────────
    for (const cf of contextFiles) {
      const managed = knownFiles.find((f) => matchesFile(cf.path, f.path));
      if (!managed) continue;            // not a managed file — leave it alone
      if (enabledFiles.has(managed.path)) continue; // user opted in — keep it
      prompt = stripSection(prompt, cf.path, cf.content);
    }

    prompt = removeEmptyContextWrapper(prompt);

    // ── Step 2: inject enabled files that aren't already in context ───────────
    const alreadyLoaded = contextFiles.map((cf) => cf.path);
    const toInject = Array.from(enabledFiles).filter(
      (f) => !alreadyLoaded.some((loaded) => matchesFile(loaded, f)),
    );

    if (toInject.length > 0) {
      const sections: string[] = [];
      for (const file of toInject) {
        const content = readFileSafe(ctx.cwd, file);
        if (content !== null) {
          sections.push(`## ${file}\n\n${content}`);
        }
      }
      if (sections.length > 0) {
        prompt += `\n\n# AI Docs Context\n\nProject documentation (manually enabled):\n\n${sections.join("\n\n")}\n`;
      }
    }

    return { systemPrompt: prompt };
  });

  // ── Session start: discover files and restore state ──────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    knownFiles = discoverFiles(ctx.cwd);

    const stateEntry = ctx.sessionManager
      .getEntries()
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "ai-docs-state",
      )
      .pop() as { data?: { enabledFiles: string[] } } | undefined;

    if (stateEntry?.data?.enabledFiles) {
      enabledFiles = new Set(stateEntry.data.enabledFiles);
    }

    updateStatus(ctx);
  });

  // ── Persist enabled-files state on each turn ─────────────────────────────────

  pi.on("turn_start", () => {
    pi.appendEntry("ai-docs-state", { enabledFiles: Array.from(enabledFiles) });
  });
}
