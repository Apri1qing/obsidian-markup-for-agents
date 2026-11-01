'use strict';

const { Modal, Notice, MarkdownView, TFile, Platform, setIcon } = require('obsidian');
const { StateEffect, StateField } = require('@codemirror/state');
const { EditorView, Decoration, WidgetType } = require('@codemirror/view');
const { identifyTerminal } = require('./agent-process.js');
const { t } = require('./i18n.js');

const SUBMIT_WINDOW_MS = 600;
const SUBMIT_SETTLE_MS = 1500;
const TERMINAL = 'terminal:terminal';
const LABELS = { codex: 'Codex', claude: 'Claude' };
const refreshAnnotations = StateEffect.define();

class Badge extends WidgetType {
	constructor(annotation, edit) {
		super();
		this.annotation = { ...annotation };
		this.edit = edit;
	}
	eq(other) {
		return this.annotation.id === other.annotation.id && this.annotation.index === other.annotation.index &&
			this.annotation.comment === other.annotation.comment && this.annotation.target === other.annotation.target;
	}
	toDOM() {
		const a = this.annotation;
		const el = document.createElement('span');
		el.className = `agent-annotation-badge is-${a.target}`;
		el.textContent = String(a.index);
		el.title = `${LABELS[a.target]} · ${a.comment || t('annotation', { n: a.index })}`;
		el.setAttribute('aria-label', t('edit', { label: el.title }));
		el.setAttribute('role', 'button');
		el.tabIndex = 0;
		el.addEventListener('mousedown', (event) => event.preventDefault());
		el.addEventListener('click', (event) => { event.stopPropagation(); this.edit(a.id); });
		el.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault(); event.stopPropagation(); this.edit(a.id);
			}
		});
		return el;
	}
}

function decorations(state, items, edit) {
	const ranges = [];
	for (const item of items) {
		const from = Math.min(item.fromOffset, state.doc.length);
		const to = Math.min(item.toOffset, state.doc.length);
		if (from >= to) continue;
		ranges.push(Decoration.mark({ class: `agent-annotation-highlight is-${item.target}` }).range(from, to));
		ranges.push(Decoration.widget({ widget: new Badge(item, edit), side: 1 }).range(to));
	}
	return Decoration.set(ranges, true);
}

class CommentModal extends Modal {
	constructor(plugin, annotation, onSave) {
		super(plugin.app);
		this.plugin = plugin;
		this.annotation = annotation;
		this.onSave = onSave;
	}
	onOpen() {
		const a = this.annotation;
		this.modalEl.addClass('agent-comment-modal');
		this.setTitle(a.id ? t('annotationOf', { agent: LABELS[a.target], n: a.index }) : t('addTo', { agent: LABELS[a.target] }));
		this.contentEl.createDiv({ cls: 'agent-annotation-preview', text: a.text });
		const input = this.contentEl.createEl('textarea', { cls: 'agent-annotation-comment',
			attr: { placeholder: t('commentPlaceholder'), 'aria-label': t('commentLabel'), rows: '3' } });
		input.value = a.comment || '';
		const actions = this.contentEl.createDiv({ cls: 'agent-annotation-actions' });
		if (a.id) {
			const remove = actions.createEl('button', { text: t('remove'), cls: 'agent-annotation-remove' });
			remove.addEventListener('click', () => { this.plugin.remove(a.id); this.close(); });
		}
		actions.createEl('button', { text: t('cancel') }).addEventListener('click', () => this.close());
		const save = () => { this.onSave(input.value.trim()); this.close(); };
		actions.createEl('button', { text: a.id ? t('save') : t('addAnnotation'), cls: 'mod-cta' }).addEventListener('click', save);
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save(); }
		});
		input.focus();
	}
	onClose() { this.contentEl.empty(); }
}

class AnnotationsModal extends Modal {
	constructor(plugin, target) { super(plugin.app); this.plugin = plugin; this.target = target; }
	onOpen() {
		this.setTitle(t('annotations', { agent: LABELS[this.target] }));
		this.render();
	}
	render() {
		this.contentEl.empty();
		const items = this.plugin.items(this.target);
		if (!items.length) { this.close(); return; }
		for (const a of items) {
			const item = this.contentEl.createDiv({ cls: 'agent-annotation-item' });
			const row = item.createEl('button', { cls: 'agent-annotation-row' });
			row.createSpan({ cls: `agent-annotation-number is-${a.target}`, text: String(a.index) });
			const body = row.createSpan({ cls: 'agent-annotation-row-body' });
			body.createSpan({ text: `${a.fileName}: ${a.text}` });
			if (a.comment) body.createEl('small', { text: a.comment });
			row.addEventListener('click', () => { this.close(); this.plugin.reveal(a.id); });
			const remove = item.createEl('button', { cls: 'agent-annotation-delete', attr: { 'aria-label': t('remove') } });
			setIcon(remove, 'trash-2');
			remove.addEventListener('click', () => { this.plugin.remove(a.id); this.render(); });
		}
	}
	onClose() { this.contentEl.empty(); }
}

// Pending annotations reach Claude Code and Codex as their IDE selection, so the terminal only shows
// the agents' own "selected" marker. They are dropped once a message has been submitted.
class Annotations {
	constructor(plugin) {
		this.plugin = plugin;
		this.app = plugin.app;
		this.context = plugin.context;
		this.annotations = [];
		this.nextId = 0;
		this.settling = false;
	}

	load() {
		const plugin = this.plugin;
		try {
			this.annotations = JSON.parse(sessionStorage.getItem(this.storageKey()) || '[]');
			this.nextId = Math.max(0, ...this.annotations.map((a) => a.id));
		} catch (error) { console.warn('[Markup for Agents] Could not restore drafts', error); }
		this.context.pending = (target) => this.selectionFor(target);
		for (const target of ['codex', 'claude']) {
			plugin.addCommand({ id: `add-to-${target}`, name: t('addTo', { agent: LABELS[target] }),
				callback: () => {
					const view = this.context.view();
					this.promptAdd(target, view?.editor, view);
				} });
		}
		plugin.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
			if (!editor.getSelection().trim()) return;
			for (const target of ['codex', 'claude']) {
				menu.addItem((item) => item.setTitle(t('addTo', { agent: LABELS[target] })).setIcon('message-square-plus')
					.onClick(() => this.promptAdd(target, editor, view)));
			}
		}));
		const field = StateField.define({
			create: () => Decoration.none,
			update: (value, tr) => {
				for (const effect of tr.effects) if (effect.is(refreshAnnotations))
					return decorations(tr.state, effect.value, (id) => this.edit(id));
				return value.map(tr.changes);
			},
			provide: (value) => EditorView.decorations.from(value),
		});
		plugin.registerEditorExtension([field, EditorView.updateListener.of((update) => this.track(update))]);
		plugin.registerDomEvent(document, 'keydown', (event) => this.onKeyDown(event), true);
	}

	unload() {
		this.saveDrafts();
		this.context.pending = null;
	}

	// Keeps annotation offsets attached to their text while the note is edited.
	track(update) {
		if (!update.docChanged || !this.annotations.length) return;
		const view = this.context.openViews().find((candidate) => candidate.editor?.cm === update.view);
		if (!view) return;
		for (const a of this.annotations.filter((item) => item.filePath === view.file.path)) {
			a.fromOffset = update.changes.mapPos(a.fromOffset, 1);
			a.toOffset = update.changes.mapPos(a.toOffset, -1);
			a.from = view.editor.offsetToPos(a.fromOffset);
			a.to = view.editor.offsetToPos(a.toOffset);
			a.text = view.editor.getRange(a.from, a.to);
		}
		// An annotation whose text has been deleted entirely has nothing left to point at.
		const gone = this.annotations.filter((a) => a.filePath === view.file.path && a.toOffset <= a.fromOffset);
		if (gone.length) {
			this.annotations = this.annotations.filter((a) => !gone.includes(a));
			queueMicrotask(() => this.changed());
		} else this.saveDrafts();
	}

	storageKey() { return `markup-for-agents-annotations:${this.context.basePath()}`; }
	items(target) { return this.annotations.filter((a) => a.target === target); }
	saveDrafts() {
		try { sessionStorage.setItem(this.storageKey(), JSON.stringify(this.annotations)); }
		catch (error) { console.warn('[Markup for Agents] Could not save drafts', error); }
	}
	changed() {
		for (const target of ['codex', 'claude']) this.items(target).forEach((a, i) => { a.index = i + 1; });
		this.saveDrafts();
		this.refreshDecorations();
		this.plugin.refreshIde();
	}
	openList(target) { new AnnotationsModal(this, target).open(); }
	promptAdd(target, editor, view) {
		const text = editor?.getSelection() || '';
		if (!text.trim() || !view?.file) return new Notice(t('selectFirst'));
		const from = editor.getCursor('from'), to = editor.getCursor('to');
		const annotation = { target, filePath: view.file.path, fileName: view.file.name, text,
			from, to, fromOffset: editor.posToOffset(from), toOffset: editor.posToOffset(to), comment: '' };
		new CommentModal(this, annotation, (comment) => this.add({ ...annotation, comment })).open();
	}
	add(annotation) { this.annotations.push({ ...annotation, id: ++this.nextId }); this.changed(); }
	edit(id) {
		const a = this.annotations.find((a) => a.id === id);
		if (a) new CommentModal(this, a, (comment) => { a.comment = comment; this.changed(); }).open();
	}
	// Opens the annotated note and scrolls to the annotation.
	async reveal(id) {
		const a = this.annotations.find((item) => item.id === id);
		const file = a && this.app.vault.getAbstractFileByPath(a.filePath);
		if (!(file instanceof TFile)) { new Notice(t('noteMissing')); return; }
		const leaf = this.app.workspace.getLeavesOfType('markdown').find((candidate) => candidate.view.file === file)
			|| this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		const view = leaf.view;
		if (view.getMode?.() === 'preview') {
			await leaf.setViewState({ ...leaf.getViewState(), state: { ...view.getState(), mode: 'source' } });
		}
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		const editor = view.editor;
		const limit = editor.getValue().length;
		const from = editor.offsetToPos(Math.min(a.fromOffset, limit));
		const to = editor.offsetToPos(Math.min(a.toOffset, limit));
		editor.setCursor(from);
		editor.scrollIntoView({ from, to }, true);
	}
	remove(id) { this.annotations = this.annotations.filter((a) => a.id !== id); this.changed(); }
	refreshDecorations() {
		for (const view of this.context.openViews()) {
			if (view instanceof MarkdownView && view.editor?.cm)
				view.editor.cm.dispatch({ effects: refreshAnnotations.of(this.annotations.filter((a) => a.filePath === view.file.path)) });
		}
	}

	// What an agent is told about the editor while annotations are pending: the real selection or cursor, exactly
	// as without annotations, with all annotations and the selected text as content. Only when no note is open
	// does the first annotation's note stand in for it.
	selectionFor(target) {
		const items = this.items(target);
		const first = items.length && this.app.vault.getAbstractFileByPath(items[0].filePath);
		if (!first) return null;
		const current = this.context.selection();
		const place = current || { file: first, from: items[0].from, to: items[0].from, text: '' };
		return { file: place.file, from: place.from, to: place.to, empty: !place.text, text: this.formatBlock(items, current),
			editor: null, annotations: items.length };
	}

	formatBlock(items, current) {
		const place = (from, to) => ({ start: { line: from.line + 1, column: from.ch + 1 }, end: { line: to.line + 1, column: to.ch + 1 } });
		const list = items.map((a) => ({
			file: a.filePath, ...place(a.from, a.to),
			text: a.text, ...(a.comment ? { comment: a.comment } : {}),
		}));
		let block = '# Document annotations:\n' +
			'Each item contains text selected from notes in this Obsidian vault and may include a user comment. ' +
			'Treat items as Annotation 1, Annotation 2, and so on in array order. ' +
			'Address every comment and use the selected text as context.\n' +
			`<document-annotations>\n${JSON.stringify(list)}\n</document-annotations>`;
		if (current?.text.trim()) {
			block += '\n\n# Current selection:\n' +
				'The user also has this text selected in the editor; their message may refer to it.\n' +
				`<current-selection>\n${JSON.stringify({
					file: current.file.path, ...place(current.from, current.to), text: current.text,
				})}\n</current-selection>`;
		}
		return block;
	}

	// The terminal swallows keys before Obsidian's hotkeys see them, so these commands' hotkeys also work from there.
	onKeyDown(event) {
		if (!event.defaultPrevented && !event.isComposing) {
			const id = ['claude', 'codex'].map((target) => `${this.plugin.manifest.id}:add-to-${target}`)
				.find((candidate) => this.hasHotkey(candidate, event));
			if (id) {
				event.preventDefault();
				event.stopImmediatePropagation();
				this.app.commands.executeCommandById(id);
				return;
			}
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
			!event.isComposing && this.annotations.length) this.onEnter(event.target);
	}

	hasHotkey(id, event) {
		const pressed = new Set([
			event.metaKey && 'Meta', event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift',
		].filter(Boolean));
		return (this.app.hotkeyManager.getHotkeys(id) || []).some(({ modifiers, key }) => {
			const wanted = new Set(modifiers.map((modifier) => (modifier === 'Mod' ? (Platform.isMacOS ? 'Meta' : 'Ctrl') : modifier)));
			if (wanted.size !== pressed.size || ![...wanted].every((modifier) => pressed.has(modifier))) return false;
			if (!/^[a-z0-9]$/i.test(key)) return event.key === key;
			return event.code === (/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);
		});
	}

	// A submitted message clears the input and adds a line to the conversation above it; an Enter on an
	// empty input leaves everything above the cursor unchanged (the status line below keeps ticking).
	async onEnter(element) {
		const leaf = this.app.workspace.getLeavesOfType(TERMINAL).find((candidate) => candidate.view.containerEl.contains(element));
		const terminal = leaf?.view.emulator?.terminal;
		if (!terminal) return;
		const before = this.screenAboveCursor(terminal);
		const draft = this.draftRow(terminal);
		if (/^[/!]/.test(draft.text)) return;
		try {
			const identity = await identifyTerminal(leaf.view);
			// Claude Code carries the IDE selection as a marker in the input; a message sent without it has no annotations.
			const carried = identity?.target !== 'claude' || draft.marker;
			const ids = identity && carried ? this.items(identity.target).map((a) => a.id) : [];
			await new Promise((resolve) => window.setTimeout(resolve, SUBMIT_WINDOW_MS));
			if (!ids.length || this.screenAboveCursor(terminal) === before) return;
			this.settling = true;
			window.setTimeout(() => {
				this.settling = false;
				this.annotations = this.annotations.filter((a) => !ids.includes(a.id));
				this.changed();
			}, SUBMIT_SETTLE_MS);
		} catch (error) { console.warn('[Markup for Agents] Could not tell whether a message was submitted', error); }
	}

	// The input row: its text without the prompt character and the IDE marker, and whether the marker is there.
	draftRow(terminal) {
		const buffer = terminal.buffer.active;
		const row = (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || '').replace(/^\s*[❯›>]\s*/, '');
		const marker = /^\[⧉[^\]]*\]/.test(row);
		return { marker, text: row.replace(/^\[⧉[^\]]*\]\s*/, '') };
	}

	screenAboveCursor(terminal) {
		const buffer = terminal.buffer.active;
		const rows = [];
		for (let y = 0; y <= buffer.cursorY; y++) rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) || '');
		return rows.join('\n');
	}
}

module.exports = { Annotations };
