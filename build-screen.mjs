// Dev-time helper — NOT loaded by feedBack itself. Concatenates the ES
// modules under src/ into a single classic (global-scope, no import/export)
// screen.js.
//
// Why this exists: this plugin was originally built as
// `"scriptType": "module"` (native ES modules, no build step, per
// CLAUDE.md) — but that feature is listed under [Unreleased] in feedBack's
// CHANGELOG and the actual feedback-desktop build the plugin was tested
// against (dated 2026-06-28) predates it: every file under src/ 404s via
// the sandboxed /api/plugins/<id>/src/{path} route, so the whole module
// graph silently fails to load and the renderer factory never registers.
// Classic global-scope screen.js is unconditionally supported (CLAUDE.md:
// "Classic global-scope screen.js remains fully supported"), so that's
// the deployed artifact now.
//
// src/*.js stay the source of truth (also what the Node-based test suite
// imports directly via ES module syntax) — screen.js is a generated
// artifact. Run `node build-screen.mjs` after editing anything under src/
// and commit the regenerated screen.js alongside it.
//
// Mechanical only: strips `import {...} from './x.js';` lines (safe once
// concatenated in dependency order — every name is already in scope by the
// time it's used) and `export ` prefixes (named exports only; this codebase
// uses no default/renamed/re-exports, so a simple prefix strip is exact,
// not a heuristic).

import { readFileSync, writeFileSync } from 'node:fs';

const ORDER = [
    'src/gl-math.js',
    'src/scene.js',
    'src/nashville.js',
    'src/sections-api.js',
    'src/nashville-file-api.js',
    'src/main.js',
];

function stripModuleSyntax(src, filename) {
    const lines = src.split('\n');
    const out = [];
    for (const line of lines) {
        if (/^import\s*\{[^}]*\}\s*from\s*'\.\/[^']+\.js';\s*$/.test(line)) {
            continue; // dropped — concatenation order already provides the binding
        }
        if (/^import\s/.test(line)) {
            throw new Error(`${filename}: unhandled import syntax, update build-screen.mjs: ${line}`);
        }
        out.push(line.replace(/^export\s+(function|async function|const|class)\s/, '$1 '));
    }
    return out.join('\n');
}

const banner = `// GENERATED FILE — do not edit directly.
// Built from src/*.js by build-screen.mjs (dev-time only, not run by
// feedBack). Edit the files under src/, then run:  node build-screen.mjs
(function () {
    'use strict';
`;

const footer = `
})();
`;

const body = ORDER.map((path) => {
    const src = readFileSync(path, 'utf-8');
    return `    // ── ${path} ${'─'.repeat(Math.max(0, 60 - path.length))}\n` +
        stripModuleSyntax(src, path).split('\n').map((l) => (l ? '    ' + l : l)).join('\n');
}).join('\n\n');

writeFileSync('screen.js', banner + body + footer, 'utf-8');
console.log(`wrote screen.js from ${ORDER.length} source files`);
