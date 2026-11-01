import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

await esbuild.build({
	entryPoints: ['src/main.js'],
	bundle: true,
	outfile: 'main.js',
	format: 'cjs',
	platform: 'node',
	target: 'es2021',
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules],
	logLevel: 'info',
});
