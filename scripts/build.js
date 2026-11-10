const fs = require('fs');
const path = require('path');

/**
 * Pure-JS TypeScript-to-Browser IIFE Bundler (`scripts/build.js`)
 *
 * Resolves the dependency graph starting from `src/bootstrap.ts`, strips TypeScript
 * type annotations while preserving all runtime enums, classes, methods, BigInt literals,
 * WGSL/GLSL template literals, and outputs `public/bootstrap.js` + copies distribution
 * files to root `index.html`, `bootstrap.js`, and `dist/` for GitHub Pages deployment.
 */

const PROJECT_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PROJECT_DIR, 'src');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');

// Ordered module list in topological dependency order
const MODULE_ORDER = [
    'wasm/jvm_core.ts',
    'runtime/long_math.ts',
    'runtime/vfs_nbt.ts',
    'runtime/openal_audio.ts',
    'runtime/worker_pool.ts',
    'runtime/pal.ts',
    'network/wisp_epoxy.ts',
    'network/microsoft_auth.ts',
    'network/protocol_26_3.ts',
    'world/noise_router.ts',
    'world/physics_tick.ts',
    'renderer/shader_compiler.ts',
    'renderer/chunk_mesher.ts',
    'renderer/render_engine.ts',
    'gui/vanilla_screens.ts',
    'bootstrap.ts',
];

let esbuild = null;
try {
    esbuild = require('esbuild');
} catch {}

async function runBuild() {
    if (esbuild) {
        await esbuild.build({
            entryPoints: [path.join(SRC_DIR, 'bootstrap.ts')],
            bundle: true,
            outfile: path.join(PUBLIC_DIR, 'bootstrap.js'),
            format: 'iife',
            target: ['es2022'],
            sourcemap: false,
        });
        console.log('[Build] Bundled with esbuild -> public/bootstrap.js');
    } else {
        // Use built-in Node v22 TypeScript type-stripping or custom TS->JS transpiler
        let stripTypeScriptTypes = null;
        try {
            const moduleApi = require('module');
            if (typeof moduleApi.stripTypeScriptTypes === 'function') {
                stripTypeScriptTypes = moduleApi.stripTypeScriptTypes;
            }
        } catch {}

        const chunks = [
            '// Minecraft 26.3 (Protocol 777, DataVersion 5023) - Compiled Web Bundle',
            '(function() {',
            '"use strict";',
        ];

        for (const relPath of MODULE_ORDER) {
            const fullPath = path.join(SRC_DIR, relPath);
            let tsCode = fs.readFileSync(fullPath, 'utf8');

            // Remove import statements
            tsCode = tsCode.replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
            // Replace `export enum Name { ... }` with standard JS object IIFE before type stripping
            tsCode = tsCode.replace(/export\s+enum\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)\}/g, (_m, enumName, body) => {
                const lines = body.split(',').map(s => s.trim()).filter(Boolean);
                let autoVal = 0;
                const pairs = [];
                for (const line of lines) {
                    const eqIdx = line.indexOf('=');
                    if (eqIdx >= 0) {
                        const k = line.slice(0, eqIdx).trim();
                        const v = line.slice(eqIdx + 1).trim().replace(/\/\/.*$/, '').trim();
                        pairs.push(`${enumName}[${JSON.stringify(k)}] = ${v};`);
                        const num = Number(v);
                        if (!isNaN(num)) autoVal = num + 1;
                    } else {
                        const k = line.replace(/\/\/.*$/, '').trim();
                        if (k) {
                            pairs.push(`${enumName}[${JSON.stringify(k)}] = ${autoVal++};`);
                        }
                    }
                }
                return `const ${enumName} = {}; (function(${enumName}){ ${pairs.join(' ')} })(${enumName});`;
            });
            tsCode = tsCode.replace(/^export\s+(interface|type)\s+/gm, '$1 ');
            tsCode = tsCode.replace(/^export\s+(class|function|const|let|var|async\s+function)\s+/gm, '$1 ');

            // Strip parameter properties `constructor(public readonly a: T, public readonly b: T)`
            tsCode = tsCode.replace(
                /constructor\s*\(\s*public\s+readonly\s+([A-Za-z0-9_]+)\s*:\s*[^,)]+,\s*public\s+readonly\s+([A-Za-z0-9_]+)\s*:\s*[^)]+\)\s*\{\s*\}/g,
                'constructor($1, $2) { this.$1 = $1; this.$2 = $2; }'
            );

            let jsCode;
            if (stripTypeScriptTypes) {
                jsCode = stripTypeScriptTypes(tsCode, { mode: 'strip' });
            } else {
                throw new Error('Node v22 module.stripTypeScriptTypes or esbuild required');
            }

            chunks.push(`\n// --- Module: ${relPath} ---\n` + jsCode);
        }

        chunks.push('})();\n');
        const finalJs = chunks.join('\n');
        fs.writeFileSync(path.join(PUBLIC_DIR, 'bootstrap.js'), finalJs, 'utf8');
        console.log(`[Build] Compiled ${MODULE_ORDER.length} TypeScript modules via Node v22 stripTypeScriptTypes -> public/bootstrap.js (${finalJs.length} bytes)`);
    }

    // Copy public/index.html and public/bootstrap.js to project root and dist/ so both root serving and dist/ serving work seamlessly
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.copyFileSync(path.join(PUBLIC_DIR, 'index.html'), path.join(PROJECT_DIR, 'index.html'));
    fs.copyFileSync(path.join(PUBLIC_DIR, 'bootstrap.js'), path.join(PROJECT_DIR, 'bootstrap.js'));
    fs.copyFileSync(path.join(PUBLIC_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
    fs.copyFileSync(path.join(PUBLIC_DIR, 'bootstrap.js'), path.join(DIST_DIR, 'bootstrap.js'));

    // Ensure root assets/ symlink or copy exists for GitHub Pages root serving
    const rootAssets = path.join(PROJECT_DIR, 'assets');
    const pubAssets = path.join(PUBLIC_DIR, 'assets');
    fs.cpSync(pubAssets, rootAssets, { recursive: true });
    fs.cpSync(pubAssets, path.join(DIST_DIR, 'assets'), { recursive: true });
    console.log('[Build] Synced index.html, bootstrap.js, and assets/ to root and dist/.');
}

runBuild().catch(err => {
    console.error(err);
    process.exit(1);
});
