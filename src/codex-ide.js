'use strict';

// Codex CLI /ide integration: answers `ide-context` requests on Codex's IPC channel
// (<CODEX_HOME>/ipc/ipc.sock, or \\.\pipe\codex-ipc on Windows). When another program already
// serves the channel, such as the Codex desktop app, this plugin joins it as a client instead.
const net = require('net');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');
const path = require('path');

const FRAME_LEN_BYTES = 4;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 500;
const RETRY_MS = 1500;
const WINDOWS_PIPE = '\\\\.\\pipe\\codex-ipc';

function range(a, b) {
	const start = { line: a.line, character: a.ch }, end = { line: b.line, character: b.ch };
	const before = start.line === end.line ? start.character <= end.character : start.line < end.line;
	return before ? { start, end } : { start: end, end: start };
}

function overlaps(a, b) {
	const x = path.resolve(a).replace(/[\\/]+$/, ''), y = path.resolve(b).replace(/[\\/]+$/, '');
	return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep);
}

class CodexIde {
	constructor(plugin) {
		this.plugin = plugin;
		this.context = plugin.context;
		this.server = null;
		this.client = null;
		this.clientId = 'obsidian-markup-for-agents';
		this.retry = null;
		this.failure = '';
	}

	socketPath() {
		if (process.platform === 'win32') return WINDOWS_PIPE;
		const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
		return path.join(home, 'ipc', 'ipc.sock');
	}

	async start() {
		this.fail('');
		const socketPath = this.socketPath();
		const probe = await this.probe(socketPath);
		if (probe === 'occupied') { this.join(socketPath); return; }
		if (process.platform !== 'win32') {
			const dir = path.dirname(socketPath);
			try { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, 0o700); }
			catch (error) { this.fail(`Could not prepare ${dir}: ${error.message}`); return; }
			if (probe === 'stale') try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
		}
		const server = net.createServer((socket) => this.connection(socket));
		server.on('error', (error) => { this.server = null; this.fail(`${socketPath}: ${error.message}`); });
		server.listen(socketPath, () => {
			try { if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ }
		});
		this.server = server;
	}

	// Registers with the router that owns the channel and answers the requests it forwards.
	join(socketPath) {
		const socket = net.createConnection(socketPath);
		this.client = socket;
		this.connection(socket);
		socket.once('connect', () => this.write(socket, { type: 'request', requestId: randomUUID(),
			sourceClientId: 'initializing-client', version: 0, method: 'initialize',
			params: { clientType: 'obsidian' }, targetClientId: null }));
		socket.once('close', () => {
			if (this.client !== socket) return;
			this.client = null;
			this.retry = setTimeout(() => this.start(), RETRY_MS);
		});
	}

	stop() {
		clearTimeout(this.retry);
		if (this.client) { const socket = this.client; this.client = null; socket.destroy(); }
		if (this.server) {
			this.server.close(); this.server = null;
			if (process.platform !== 'win32') try { fs.unlinkSync(this.socketPath()); } catch { /* already gone */ }
		}
	}

	probe(socketPath) {
		return new Promise((resolve) => {
			if (process.platform !== 'win32' && !fs.existsSync(socketPath)) { resolve('absent'); return; }
			const client = net.createConnection(socketPath);
			let done = false;
			const finish = (result) => {
				if (done) return;
				done = true; client.removeAllListeners(); client.destroy(); resolve(result);
			};
			client.once('connect', () => finish('occupied'));
			client.once('error', () => finish('stale'));
			setTimeout(() => finish('stale'), PROBE_TIMEOUT_MS);
		});
	}

	// Records why the channel is unusable; the Codex panel shows it. Empty while the channel works.
	fail(message) {
		this.failure = message;
		this.plugin.panel?.update();
	}

	connection(socket) {
		let buffer = Buffer.alloc(0);
		socket.on('data', (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (buffer.length < FRAME_LEN_BYTES) return;
				const length = buffer.readUInt32LE(0);
				if (length > MAX_FRAME_BYTES) { socket.destroy(); return; }
				if (buffer.length < FRAME_LEN_BYTES + length) return;
				const payload = buffer.subarray(FRAME_LEN_BYTES, FRAME_LEN_BYTES + length);
				buffer = buffer.subarray(FRAME_LEN_BYTES + length);
				this.message(socket, payload);
			}
		});
		socket.on('error', () => {});
	}

	write(socket, message) {
		const payload = Buffer.from(JSON.stringify(message), 'utf8');
		const header = Buffer.alloc(FRAME_LEN_BYTES);
		header.writeUInt32LE(payload.length, 0);
		socket.write(Buffer.concat([header, payload]));
	}

	message(socket, payload) {
		let message;
		try { message = JSON.parse(payload.toString('utf8')); } catch { return; }
		if (!message || typeof message !== 'object') return;
		if (message.type === 'response' && socket === this.client) {
			const id = message.result?.clientId;
			if (message.resultType === 'success' && typeof id === 'string') this.clientId = id;
		} else if (message.type === 'request') {
			if (message.method === 'ide-context') {
				this.write(socket, { type: 'response', requestId: message.requestId, resultType: 'success',
					method: 'ide-context', handledByClientId: this.clientId,
					result: { ideContext: this.ideContext(message.params || {}) } });
			} else if (message.requestId) {
				this.write(socket, { type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-handler-for-request' });
			}
		} else if (message.type === 'client-discovery-request' && message.requestId) {
			this.write(socket, { type: 'client-discovery-response', requestId: message.requestId,
				response: { canHandle: message.request?.method === 'ide-context' } });
		}
	}

	ideContext(params) {
		const root = params.workspaceRoot;
		if (root && !overlaps(this.context.basePath(), root)) return { activeFile: null, openTabs: [] };
		const openTabs = this.context.openViews().map((view) => ({ label: view.file.name, path: view.file.path }));
		const info = this.context.selection('codex');
		let activeFile = null;
		if (info) {
			const editor = info.editor;
			activeFile = { label: info.file.name, path: info.file.path,
				selection: range(info.from, info.to), activeSelectionContent: info.text,
				selections: editor ? editor.listSelections().map((s) => range(s.anchor, s.head)) : [] };
		}
		return { activeFile, openTabs };
	}
}

module.exports = { CodexIde };
