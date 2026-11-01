'use strict';

// Claude Code IDE integration: a local WebSocket server announced through ~/.claude/ide/<port>.lock.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { TEXT: 1, CLOSE: 8, PING: 9, PONG: 10 };
const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide');
const READY_DELAY_MS = 500;
const BROADCAST_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = 30000;

const TOOLS = [
	['getCurrentSelection', 'Get the current selection in the active editor'],
	['getLatestSelection', 'Get the most recent selection (cached from last change)'],
	['getOpenEditors', 'Get all open editor tabs'],
	['getWorkspaceFolders', 'Get workspace folder paths'],
].map(([name, description]) => ({ name, description, inputSchema: { type: 'object', properties: {} } }));

const STUB_TOOLS = {
	openDiff: { success: false }, getDiagnostics: { diagnostics: [] }, checkDocumentDirty: { isDirty: false },
	saveDocument: { success: true }, close_tab: { success: false }, closeAllDiffTabs: { success: true },
	executeCode: { success: false },
};

function decodeFrame(buf) {
	if (buf.length < 2) return null;
	const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
	let len = buf[1] & 0x7f, offset = 2;
	if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
	else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
	const maskLen = masked ? 4 : 0;
	if (buf.length < offset + maskLen + len) return null;
	const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
	if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[offset + (i % 4)];
	return { fin, opcode, payload, size: offset + maskLen + len };
}

function encodeFrame(opcode, data) {
	const payload = typeof data === 'string' ? Buffer.from(data) : data;
	let header;
	if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
	else if (payload.length < 65536) {
		header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2);
	}
	else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
	return Buffer.concat([header, payload]);
}

function isEmpty(info) { return info.empty ?? info.text === ''; }

function pathFor(context, file) { return path.join(context.basePath(), file.path); }

function selectionPayload(context, info) {
	const filePath = pathFor(context, info.file);
	return {
		text: info.text, filePath, fileUrl: `file://${filePath}`,
		selection: {
			start: { line: info.from.line, character: info.from.ch },
			end: { line: info.to.line, character: info.to.ch },
			isEmpty: isEmpty(info),
		},
	};
}

class ClaudeIde {
	constructor(plugin) {
		this.plugin = plugin;
		this.context = plugin.context;
		this.clients = new Set();
		this.latest = null;
		this.lastSent = null;
		this.timer = null;
		this.revision = 0;
	}

	async start() {
		this.removeStaleLocks();
		this.authToken = crypto.randomUUID();
		this.server = http.createServer((req, res) => { res.writeHead(400); res.end(); });
		this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
		this.port = await new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
		});
		this.writeLock();
		this.heartbeat = window.setInterval(() => this.ping(), HEARTBEAT_MS);
	}

	stop() {
		window.clearTimeout(this.timer);
		window.clearInterval(this.heartbeat);
		for (const client of this.clients) client.socket.destroy();
		this.clients.clear();
		this.server?.close();
		if (this.port) try { fs.unlinkSync(path.join(LOCK_DIR, `${this.port}.lock`)); } catch { /* already gone */ }
	}

	writeLock() {
		fs.mkdirSync(LOCK_DIR, { recursive: true });
		const file = path.join(LOCK_DIR, `${this.port}.lock`);
		fs.writeFileSync(`${file}.tmp`, JSON.stringify({
			pid: process.pid, workspaceFolders: [this.context.basePath()],
			ideName: 'Obsidian', transport: 'ws', authToken: this.authToken,
		}), { mode: 0o600 });
		fs.renameSync(`${file}.tmp`, file);
	}

	// Lock files of Obsidian processes that no longer run are removed; other IDEs' locks are left alone.
	removeStaleLocks() {
		let names = [];
		try { names = fs.readdirSync(LOCK_DIR).filter((name) => name.endsWith('.lock')); } catch { return; }
		for (const name of names) {
			const file = path.join(LOCK_DIR, name);
			try {
				const lock = JSON.parse(fs.readFileSync(file, 'utf-8'));
				if (lock?.ideName !== 'Obsidian') continue;
				if (lock.pid === process.pid) throw new Error('own stale lock');
				process.kill(lock.pid, 0);
			} catch { try { fs.unlinkSync(file); } catch { /* already gone */ } }
		}
	}

	upgrade(req, socket, head) {
		const key = req.headers['sec-websocket-key'];
		if (req.headers['x-claude-code-ide-authorization'] !== this.authToken) {
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
		}
		if (!key || Array.isArray(key)) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
		const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
		const protocol = req.headers['sec-websocket-protocol'];
		socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${accept}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}\r\n`);
		const client = { socket, buffer: Buffer.alloc(0), alive: true };
		if (head.length) socket.unshift(head);
		this.clients.add(client);
		socket.on('data', (chunk) => { client.buffer = Buffer.concat([client.buffer, chunk]); this.read(client); });
		socket.on('close', () => this.clients.delete(client));
		socket.on('error', () => this.clients.delete(client));
	}

	read(client) {
		for (;;) {
			const frame = decodeFrame(client.buffer);
			if (!frame) return;
			client.buffer = client.buffer.subarray(frame.size);
			if (!client.socket.writable) return;
			if (frame.opcode === OP.PING) client.socket.write(encodeFrame(OP.PONG, frame.payload));
			else if (frame.opcode === OP.PONG) client.alive = true;
			else if (frame.opcode === OP.CLOSE) {
				client.socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0)));
				client.socket.destroy();
				this.clients.delete(client);
				return;
			}
			else if (frame.fin && frame.opcode === OP.TEXT) this.message(client, frame.payload.toString());
			else { client.socket.destroy(); this.clients.delete(client); return; }
		}
	}

	message(client, text) {
		let request;
		try { request = JSON.parse(text); }
		catch { this.send(client, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
		if (request.id === undefined || request.id === null) {
			if (request.method === 'ide_connected') this.whenReady(client);
			return;
		}
		try { this.send(client, this.respond(request)); }
		catch (error) {
			console.error('[Markup for Agents] Claude Code request failed', error);
			this.send(client, { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'Internal error' } });
		}
	}

	// Claude Code ignores selections sent before its connection handshake finishes.
	whenReady(client) {
		window.setTimeout(() => {
			if (!this.clients.has(client)) return;
			const info = this.shared();
			if (info) this.send(client, { jsonrpc: '2.0', method: 'selection_changed', params: selectionPayload(this.context, info) });
			else this.lastSent = null;
		}, READY_DELAY_MS);
	}

	respond(request) {
		const reply = (result) => ({ jsonrpc: '2.0', id: request.id, result });
		const fail = (message) => ({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message } });
		if (request.method === 'initialize') {
			return reply({ protocolVersion: request.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} },
				serverInfo: { name: 'markup-for-agents', version: this.plugin.manifest.version } });
		}
		if (request.method === 'tools/list') return reply({ tools: TOOLS });
		if (request.method !== 'tools/call') return fail('Method not found');
		const name = request.params?.name;
		const result = this.tool(name);
		return result ? reply(result) : fail(`Tool not found: ${name}`);
	}

	tool(name) {
		const content = (value, isError) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
		const base = this.context.basePath();
		switch (name) {
			case 'getCurrentSelection': return content(this.snapshot() || { error: 'no active file' });
			case 'getLatestSelection': return content(this.latest || { error: 'no selection tracked yet' });
			case 'getWorkspaceFolders': return content({ folders: [base] });
			case 'getOpenEditors': {
				const active = this.context.view();
				return content({ tabs: this.context.openViews().map((view) => ({
					uri: `file://${pathFor(this.context, view.file)}`, isActive: view === active,
					label: view.file.basename, languageId: 'markdown' })) });
			}
			default: return name in STUB_TOOLS ? content(STUB_TOOLS[name]) : null;
		}
	}

	snapshot() {
		const info = this.shared();
		if (!info) return null;
		const cursor = info.editor ? info.editor.getCursor() : info.from;
		return {
			filePath: pathFor(this.context, info.file), relativePath: info.file.path,
			cursor: { line: cursor.line, character: cursor.ch },
			selection: { start: { line: info.from.line, character: info.from.ch },
				end: { line: info.to.line, character: info.to.ch }, isEmpty: isEmpty(info), text: info.text },
		};
	}

	send(client, message) { if (client.socket.writable) client.socket.write(encodeFrame(OP.TEXT, JSON.stringify(message))); }
	broadcast(message) { for (const client of this.clients) this.send(client, message); }
	ping() {
		for (const client of this.clients) {
			if (!client.alive) { client.socket.destroy(); this.clients.delete(client); continue; }
			client.alive = false;
			if (client.socket.writable) client.socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
		}
	}

	// Claude Code only redraws a dismissed selection marker when the selection changes. Annotation
	// selections therefore carry invisible revision characters that restoreSelection() adds.
	shared() {
		const info = this.context.selection('claude');
		return info?.annotations ? { ...info, text: info.text + '\u200b'.repeat(this.revision) } : info;
	}

	restoreSelection() {
		this.revision++;
		this.resetSent();
		this.broadcastSelection();
	}

	resetSent() { this.lastSent = null; }

	scheduleBroadcast() {
		window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => this.broadcastSelection(), BROADCAST_DEBOUNCE_MS);
	}

	broadcastSelection() {
		const snapshot = this.snapshot();
		if (!snapshot) return;
		this.latest = snapshot;
		const key = JSON.stringify(snapshot);
		if (key === this.lastSent) return;
		this.lastSent = key;
		this.broadcast({ jsonrpc: '2.0', method: 'selection_changed', params: selectionPayload(this.context, this.shared()) });
	}

	mention() {
		const info = this.context.selection();
		if (!info) return;
		const rel = info.file.path.includes(' ') ? `"${info.file.path}"` : info.file.path;
		const params = info.text ? { filePath: rel, lineStart: info.from.line, lineEnd: info.to.line } : { filePath: rel };
		this.broadcast({ jsonrpc: '2.0', method: 'at_mentioned', params });
	}
}

module.exports = { ClaudeIde };
