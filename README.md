# Markup for Agents

Annotate passages in your notes and send them, with your comments, to [Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) running in Obsidian terminals.

[简体中文](README.zh-CN.md)

## What it does

- **Annotations.** Select text, choose *Add to Claude* or *Add to Codex*, and optionally write a comment. The passage is highlighted in the note and numbered. All pending annotations ride along with your next message to that agent, together with the text you currently have selected. The terminal shows no extra text, and the annotations are dropped once the message is submitted.
- **Selection sharing.** Claude Code and Codex see the active note, the selected text and the open tabs through their own IDE integrations (`/ide`). You do not paste anything.
- **A panel under each terminal** that runs Claude Code or Codex shows what will be shared (the selection) and how many annotations are waiting. It also tells you when the agent is not connected.

## Requirements

- Obsidian 1.7.0 or later, desktop only.
- [Claude Code](https://claude.com/claude-code) and/or [Codex CLI](https://github.com/openai/codex).
- The [Terminal](https://github.com/polyipseity/obsidian-terminal) plugin, to run the agents inside Obsidian and to get the panel. Sharing the selection works from any terminal started in the vault folder.

## Usage

1. Start `claude` or `codex` in a terminal whose working directory is your vault.
2. Connect the IDE integration:
   - **Claude Code** connects by itself when *Auto-connect to IDE* is enabled (`/config`). Otherwise type `/ide`.
   - **Codex** needs `/ide` once per session. Its footer shows `IDE context` when it is on.
3. To annotate, select text and use the editor context menu or the command palette. For a hotkey, assign one to *Add to Claude* or *Add to Codex* under *Settings → Hotkeys*; it also works while a terminal has focus.
4. The panel under the terminal shows how many annotations are waiting. Click it to see the list, and click an entry to jump to that passage in its note. Click a numbered badge in the note to edit or remove the annotation, or use the trash button in the list. Deleting the annotated text removes its annotation.
5. Write your message in the terminal and press Enter.

### Commands

| Command | Action |
| --- | --- |
| Add to Claude / Add to Codex | Annotate the selected text |
| Mention selection in Claude | Send an `@` reference to the selection to Claude Code |
| Restart Codex IDE server | Reconnect the Codex channel |

## What it touches on your machine

- Starts a WebSocket server on `127.0.0.1` (random port, protected by a token) and writes `~/.claude/ide/<port>.lock` so that Claude Code finds it. The file is removed when the plugin unloads.
- For Codex, answers on Codex's local IPC channel (`~/.codex/ipc/ipc.sock`, or `\\.\pipe\codex-ipc` on Windows). If another program such as the Codex desktop app already owns that channel, the plugin joins it as a client instead of competing.
- Reads the visible screen of terminals to see the agent's input and footer, and runs `ps` to tell which terminal runs which agent.
- Makes no network requests. The only data that leaves Obsidian is what you hand to the agents: the selected text, open tab names and annotations.

## Limitations

- The Claude Code and Codex IDE protocols are not formally documented. This plugin follows their observed behaviour and may break when they change.
- The panel relies on the Terminal plugin's internal terminal object.
- Windows support follows Codex's named-pipe design but has not been tested.

## License

[MIT](LICENSE)
