'use strict';

const { MarkdownView } = require('obsidian');

// Tracks the markdown view whose note and selection are shared with the agents.
class NoteContext {
	constructor(app) {
		this.app = app;
		this.lastView = null;
	}

	remember() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) this.lastView = view;
	}

	view() {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file) return active;
		if (this.lastView?.file && this.lastView.containerEl.isShown()) return this.lastView;
		const visible = this.openViews().filter((view) => view.containerEl.isShown());
		if (visible.length !== 1) return null;
		this.lastView = visible[0];
		return this.lastView;
	}

	openViews() {
		return this.app.workspace.getLeavesOfType('markdown').map((leaf) => leaf.view).filter((view) => view.file);
	}

	basePath() { return this.app.vault.adapter.getBasePath(); }

	// Selection shared with an agent. Pending annotations of that agent take the place of the editor selection.
	selection(target, view = this.view()) {
		const pending = target && this.pending?.(target);
		if (pending) return pending;
		if (!view?.file) return null;
		const editor = view.getMode?.() === 'preview' ? null : view.editor;
		const from = editor ? editor.getCursor('from') : { line: 0, ch: 0 };
		const to = editor ? editor.getCursor('to') : { line: 0, ch: 0 };
		return { file: view.file, from, to, text: editor ? editor.getSelection() : '', editor };
	}
}

module.exports = { NoteContext };
