'use strict';

const { execFile } = require('child_process');
const path = require('path');

function processTable() {
	return new Promise((resolve, reject) => {
		execFile('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 2000 }, (error, stdout) => {
			if (error) return reject(error);
			resolve(stdout.split('\n').flatMap((line) => {
				const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
				return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
			}));
		});
	});
}

function agentProcess(processes, rootPid) {
	const children = new Map();
	for (const process of processes) {
		if (!children.has(process.parent)) children.set(process.parent, []);
		children.get(process.parent).push(process);
	}
	let level = children.get(rootPid) || [];
	const visited = new Set([rootPid]);
	while (level.length) {
		const matches = level.filter((p) => /^(claude|codex)$/.test(path.basename(p.command)));
		if (matches.length) {
			return matches.length === 1 ? { target: path.basename(matches[0].command), pid: matches[0].pid } : null;
		}
		level = level.flatMap((p) => {
			if (visited.has(p.pid)) return [];
			visited.add(p.pid);
			return children.get(p.pid) || [];
		});
	}
	return null;
}

async function identifyTerminal(view, processes) {
	const emulator = view.emulator;
	if (!emulator) return null;
	const pty = await emulator.pseudoterminal;
	const shell = await pty?.shell;
	if (!shell?.pid || emulator !== view.emulator) return null;
	return agentProcess(processes || await processTable(), shell.pid);
}

module.exports = { processTable, identifyTerminal };
