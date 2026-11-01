'use strict';

const { Plugin } = require('obsidian');
const { EditorView } = require('@codemirror/view');

const { NoteContext } = require('./context.js');
const { ClaudeIde } = require('./claude-ide.js');
const { CodexIde } = require('./codex-ide.js');
const { Annotations } = require('./annotations.js');
const { AgentPanel } = require('./panel.js');
const { t } = require('./i18n.js');

module.exports = class MarkupForAgents extends Plugin {
	async onload() {
		this.context = new NoteContext(this.app);
		this.annotations = new Annotations(this);
		this.claude = new ClaudeIde(this);
		this.codex = new CodexIde(this);
		this.panel = new AgentPanel(this);

		this.annotations.load();
		this.panel.start();

		this.addCommand({ id: 'mention-in-claude', name: t('mentionCommand'),
			editorCallback: () => this.claude.mention() });
		this.addCommand({ id: 'restart-codex-ide-server', name: t('restartCommand'),
			callback: () => { this.codex.stop(); this.codex.start(); } });

		this.refreshIde = () => {
			this.claude.resetSent();
			this.claude.scheduleBroadcast();
			this.panel.update();
		};
		const refresh = () => {
			this.context.remember();
			this.annotations.refreshDecorations();
			this.panel.update();
			this.claude.scheduleBroadcast();
		};
		this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
		this.registerEvent(this.app.workspace.on('file-open', refresh));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.panel.scan()));
		this.registerEditorExtension(EditorView.updateListener.of((update) => {
			if (!update.selectionSet && !update.docChanged) return;
			this.panel.update();
			this.claude.scheduleBroadcast();
		}));
		this.registerDomEvent(activeWindow, 'focus', () => {
			this.claude.resetSent();
			this.claude.scheduleBroadcast();
		});

		this.app.workspace.onLayoutReady(() => {
			this.context.remember();
			this.annotations.refreshDecorations();
			this.panel.scan();
		});

		await Promise.all([this.claude.start(), this.codex.start()]);
	}

	onunload() {
		this.claude.stop();
		this.codex.stop();
		this.panel.stop();
		this.annotations.unload();
	}
};
