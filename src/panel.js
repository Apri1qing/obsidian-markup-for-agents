
'use strict';

// A panel under each terminal that runs Claude Code or Codex: the note selection shared with the agent and
// the annotations waiting for it. The panel is part of Obsidian's interface, so typing in the terminal cannot remove it.
const { processTable, identifyTerminal } = require('./agent-process.js');
const { t } = require('./i18n.js');

const TERMINAL = 'terminal:terminal';
const SCAN_MS = 3000;
const KEEP_MS = 700;
const RESTORE_INTERVAL_MS = 1500;
const MAX_RESTORES = 3;
const LABELS = { claude: 'Claude', codex: 'Codex' };
// Claude Code draws the shared selection as "[⧉ …]" at the start of its input row.
const INPUT_MARKER = /^\s*[❯>]\s*(\[⧉[^\]]*\])\s?/;
// Codex's footer, the rows under its "›" input, names "IDE context" while /ide is on.
const CODEX_INPUT = /^\s*›/;
const CODEX_IDE_ON = /IDE context/;
const ERASING_KEYS = (event) => event.key === 'Backspace' || (event.ctrlKey && ['u', 'w'].includes(event.key));

class AgentPanel {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.context = plugin.context;
		this.panels = new Map();
		this.scanning = false;
	}

	start() {
		this.plugin.registerInterval(window.setInterval(() => this.scan(), SCAN_MS));
		this.plugin.registerInterval(window.setInterval(() => this.tick(), KEEP_MS));
		this.plugin.registerDomEvent(document, 'keydown', (event) => this.keepMarker(event), true);
	}

	stop() {
		for (const panel of this.panels.values()) this.remove(panel);
		this.panels.clear();
	}

	async scan() {
		if (this.scanning) return;
		this.scanning = true;
		try {
			const leaves = this.app.workspace.getLeavesOfType(TERMINAL);
			for (const [id, panel] of this.panels) {
				if (!leaves.includes(panel.leaf)) { this.remove(panel); this.panels.delete(id); }
			}
			const processes = leaves.length ? await processTable() : [];
			for (const leaf of leaves) {
				const identity = await identifyTerminal(leaf.view, processes);
				const panel = this.panels.get(leaf.id);
				if (!identity) {
					if (panel) { this.remove(panel); this.panels.delete(leaf.id); }
				} else if (!panel || panel.target !== identity.target) {
					if (panel) this.remove(panel);
					this.panels.set(leaf.id, { leaf, target: identity.target });
				}
			}
			this.update();
		} catch (error) { console.warn('[Markup for Agents] Terminal detection failed', error); }
		finally { this.scanning = false; }
	}

	update() {
		const editor = this.selectionLabel();
		for (const panel of this.panels.values()) {
			const host = panel.leaf.view.contentEl;
			if (!panel.el || panel.el.parentElement !== host) {
				panel.el?.remove();
				host.addClass('agent-panel-host');
				panel.el = host.createDiv({ cls: `agent-panel is-${panel.target}` });
				panel.selection = panel.el.createSpan({ cls: 'agent-panel-selection' });
				panel.annotations = panel.el.createEl('button', { cls: 'agent-panel-annotations' });
				panel.annotations.addEventListener('click', () => this.plugin.annotations.openList(panel.target));
			}
			const count = this.plugin.annotations.items(panel.target).length;
			const failure = panel.target === 'codex' ? this.plugin.codex.failure : '';
			const offline = failure !== '' || (panel.target === 'claude' && this.plugin.claude.clients.size === 0)
				|| (panel.target === 'codex' && panel.ide === false);
			// Claude Code shows what it will attach as a marker in its input; the panel shows that marker's text.
			const label = failure ? t('channelError') : offline ? t('notConnected') : panel.target === 'claude' ? panel.marker : editor;
			panel.selection.setText(label ? (offline ? label : `⧉ ${label}`) : '');
			panel.selection.toggleClass('is-offline', offline);
			panel.selection.setAttr('title', failure);
			panel.selection.toggle(!!label);
			panel.annotations.setText(t('annotationCount', { n: count }));
			panel.annotations.toggle(count > 0);
		}
	}

	remove(panel) {
		const host = panel.leaf.view.contentEl;
		panel.el?.remove();
		host.removeClass('agent-panel-host');
	}

	// The note selection the editor currently has, in the wording the agents use.
	selectionLabel() {
		const info = this.context.selection();
		if (!info) return null;
		if (!info.text) return t('inFile', { file: info.file.name });
		const lines = info.to.line - info.from.line + (info.to.line > info.from.line && info.to.ch === 0 ? 0 : 1);
		return t('linesSelected', { n: lines });
	}

	// Reads Claude Code's input row: the marker's text for the panel, and, while annotations are pending,
	// a repeat of the selection if the marker was deleted anyway so that Claude Code draws it back.
	tick() {
		const annotations = this.plugin.annotations;
		const claude = this.plugin.claude;
		const pending = annotations.items('claude').length > 0;
		if (!pending) claude.revision = 0;
		let changed = false;
		for (const panel of this.panels.values()) {
			if (panel.target !== 'claude') continue;
			const buffer = panel.leaf.view.emulator?.terminal?.buffer.active;
			const row = buffer?.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
			if (!/^\s*[❯>]/.test(row)) continue;
			const marker = row.match(INPUT_MARKER);
			const text = marker ? marker[1].slice(1, -1).replace(/^⧉\s*/, '') : null;
			if (text !== panel.marker) { panel.marker = text; changed = true; }
			if (!pending || annotations.settling) { panel.restores = 0; continue; }
			if (marker) { panel.restores = 0; continue; }
			if ((panel.restores || 0) >= MAX_RESTORES || Date.now() - (panel.restoredAt || 0) < RESTORE_INTERVAL_MS) continue;
			panel.restores = (panel.restores || 0) + 1;
			panel.restoredAt = Date.now();
			claude.restoreSelection();
		}
		for (const panel of this.panels.values()) {
			if (panel.target !== 'codex') continue;
			const ide = this.codexIdeOn(panel);
			if (ide !== panel.ide) { panel.ide = ide; changed = true; }
		}
		if (changed || this.lastOffline !== (claude.clients.size === 0)) {
			this.lastOffline = claude.clients.size === 0;
			this.update();
		}
	}

	// Whether Codex's footer says /ide is on; null while no input row with a footer is on screen.
	codexIdeOn(panel) {
		const terminal = panel.leaf.view.emulator?.terminal;
		if (!terminal) return null;
		const buffer = terminal.buffer.active;
		const rows = [];
		for (let y = buffer.baseY; y < buffer.baseY + terminal.rows; y++) rows.push(buffer.getLine(y)?.translateToString(true) || '');
		const input = rows.findLastIndex((row) => CODEX_INPUT.test(row));
		const footer = input < 0 ? [] : rows.slice(input + 1).filter((row) => row.trim());
		return footer.length ? footer.some((row) => CODEX_IDE_ON.test(row)) : null;
	}

	targetOf(element) {
		for (const panel of this.panels.values()) if (panel.leaf.view.containerEl.contains(element)) return panel;
		return null;
	}

	// While annotations ride on Claude Code's marker, keystrokes that would erase it never reach the terminal.
	keepMarker(event) {
		if (!ERASING_KEYS(event) || event.isComposing) return;
		const panel = this.targetOf(event.target);
		if (panel?.target !== 'claude' || !this.plugin.annotations.items('claude').length) return;
		const terminal = panel.leaf.view.emulator?.terminal;
		if (!terminal) return;
		const buffer = terminal.buffer.active;
		const row = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '';
		const marker = row.match(INPUT_MARKER);
		if (!marker || buffer.cursorX > marker[0].length) return;
		event.preventDefault();
		event.stopImmediatePropagation();
	}
}

module.exports = { AgentPanel };
