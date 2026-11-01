'use strict';

const { moment } = require('obsidian');

const STRINGS = {
	en: {
		addTo: 'Add to {agent}',
		annotation: 'Annotation {n}',
		annotationOf: '{agent} · Annotation {n}',
		annotations: '{agent} annotations',
		annotationCount: '{n} annotations',
		annotationCount_one: '1 annotation',
		edit: 'Edit {label}',
		commentPlaceholder: 'Add an optional comment…',
		commentLabel: 'Annotation comment',
		addAnnotation: 'Add annotation',
		save: 'Save',
		remove: 'Remove',
		cancel: 'Cancel',
		selectFirst: 'Select some text first.',
		noteMissing: 'This note no longer exists.',
		notConnected: 'Not connected · type /ide',
		channelError: 'Codex channel error',
		inFile: 'In {file}',
		linesSelected: '{n} lines selected',
		linesSelected_one: '1 line selected',
		mentionCommand: 'Mention selection in Claude',
		restartCommand: 'Restart Codex IDE server',
	},
	zh: {
		addTo: '添加到 {agent}',
		annotation: '批注 {n}',
		annotationOf: '{agent} · 批注 {n}',
		annotations: '{agent} 批注',
		annotationCount: '{n} 条批注',
		edit: '编辑 {label}',
		commentPlaceholder: '添加评论（可选）…',
		commentLabel: '批注评论',
		addAnnotation: '添加批注',
		save: '保存',
		remove: '删除',
		cancel: '取消',
		selectFirst: '请先选中文字。',
		noteMissing: '该笔记已不存在。',
		notConnected: '未连接 · 输入 /ide',
		channelError: 'Codex 通道错误',
		inFile: '在 {file} 中',
		linesSelected: '已选中 {n} 行',
		mentionCommand: '在 Claude 中提及选区',
		restartCommand: '重启 Codex IDE 服务',
	},
};

// Text for the interface language of Obsidian; English wherever a translation is missing.
function t(key, vars = {}) {
	const strings = STRINGS[moment.locale().startsWith('zh') ? 'zh' : 'en'];
	const one = vars.n === 1 ? strings[`${key}_one`] : undefined;
	const template = one ?? strings[key] ?? STRINGS.en[key];
	return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
}

module.exports = { t };
