# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` bundles `src/main.js` into the root `main.js` with esbuild (`obsidian`, `electron`, `@codemirror/*`, `@lezer/*` and Node builtins stay external). The root `main.js` is a build output and is git-ignored; `src/main.js` is the entry point and is tracked.
- There is no test suite or linter. Verify changes by copying `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/markup-for-agents/` and reloading the plugin in Obsidian (the `obsidian` CLI can drive it: `obsidian vault="<vault>" eval code="…"`).
- Release: `npm version <x.y.z>` runs `version-bump.mjs`, which syncs `manifest.json` and `versions.json`. The GitHub release tag must equal the `manifest.json` version (no `v` prefix) and carry `main.js`, `manifest.json`, `styles.css` as assets. The push token has no `workflow` scope, so there is no release workflow; releases are made with `gh release create`.

## Architecture

An Obsidian desktop plugin (CommonJS, no TypeScript) that lets Claude Code and Codex, running in Obsidian terminals, see the active note and the user's annotations. It talks to each agent through that agent's own IDE integration; nothing is pasted into the terminal.

- `main.js` (in `src/`) wires `NoteContext`, `Annotations`, `ClaudeIde`, `CodexIde` and `AgentPanel` together and starts both IDE servers.
- `context.js` produces the "selection" (file, range, text) of the active editor for a given target; both IDE channels and the annotation payload are built from it.
- `claude-ide.js` is a hand-rolled WebSocket server on 127.0.0.1 (random port) announced through `~/.claude/ide/<port>.lock` with an auth token. It sends `selection_changed` / `at_mentioned` JSON-RPC messages and relies on Claude Code's `autoConnectIde`.
- `codex-ide.js` speaks Codex's IPC protocol: 4-byte little-endian length-prefixed JSON frames over `$CODEX_HOME/ipc/ipc.sock` (named pipe `\\.\pipe\codex-ipc` on Windows). If the Codex desktop app already holds the socket, the plugin joins it as a client of the app's router (`initialize`, `client-discovery-request`, `ide-context`); otherwise it listens itself and retries on close. `selection` in the response must always be a range object, never `null`.
- `annotations.js` owns the annotation list, CodeMirror decorations, the modal, hotkey fallback and the "message submitted" heuristic. Pending annotations are delivered as part of the IDE selection content (`# Document annotations:` block plus `<document-annotations>` JSON) and are cleared after a submission is detected. Annotation offsets are mapped through CodeMirror `ChangeSet`s, and an annotation whose text is fully deleted is removed. Images pasted into a comment are saved with `getAvailablePathForAttachment` and embedded; each item's `images` lists the image files embedded in its text or comment as absolute paths for the agents to open.
- `panel.js` draws the status strip under a terminal and decides what it says. It depends on the Terminal plugin's internals (`leaf.view.emulator.terminal`, an xterm instance) and reads the screen to detect Codex's "IDE context" footer and Claude's `[⧉ In …]` marker. `agent-process.js` identifies which agent runs in a terminal via `ps`.
- `i18n.js` holds `en`/`zh` strings, picked from `moment.locale()`; always add both languages. `t()` uses a `_one` key only if the active language defines it.

## Conventions

- Community-plugin guidelines apply: no default hotkeys, no global `app`, no `innerHTML`, no hard-coded styles (use classes in `styles.css`), no unnecessary logging, prefer the Vault API over the adapter.
- The Claude and Codex protocols are undocumented; behavior was established by experiment, so re-verify against real sessions after changing either IDE module.
