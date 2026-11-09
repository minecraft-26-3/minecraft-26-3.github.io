const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PROJECT_DIR = path.resolve(__dirname, '..');
const PUBLIC_ASSETS = path.join(PROJECT_DIR, 'public/assets');

async function verifyAll() {
    console.log('=== Minecraft 26.3 (Protocol 777, DataVersion 5023) Verification Suite ===');

    // 1. Verify bootstrap.js syntax
    const bundleCode = fs.readFileSync(path.join(PROJECT_DIR, 'public/bootstrap.js'), 'utf8');
    new vm.Script(bundleCode, { filename: 'bootstrap.js' });
    console.log(`[PASS] public/bootstrap.js (${bundleCode.length} bytes) parsed cleanly with zero JS syntax errors.`);

    // 2. Verify registries.json & worldgen.json & shaders.json
    const reg = JSON.parse(fs.readFileSync(path.join(PUBLIC_ASSETS, 'registries.json'), 'utf8'));
    const wg = JSON.parse(fs.readFileSync(path.join(PUBLIC_ASSETS, 'worldgen.json'), 'utf8'));
    const sh = JSON.parse(fs.readFileSync(path.join(PUBLIC_ASSETS, 'shaders.json'), 'utf8'));

    if (reg.protocol_version !== 777 || reg.data_version !== 5023) {
        throw new Error(`Unexpected version metadata: ${reg.protocol_version} / ${reg.data_version}`);
    }
    console.log(`[PASS] registries.json: ${reg.blocks.length} blocks, ${reg.items.length} items, ${reg.entities.length} entities, ${reg.biomes.length} biomes, ${reg.particles.length} particles.`);
    console.log(`[PASS] worldgen.json: ${Object.keys(wg.noise_settings).length} noise_settings, ${Object.keys(wg.density_functions).length} density_functions, ${Object.keys(wg.noises).length} noises.`);
    console.log(`[PASS] shaders.json: ${Object.keys(sh.core).length} core shaders, ${Object.keys(sh.include).length} include shaders, ${Object.keys(sh.post).length} post shaders.`);

    // 3. Verify mc26_3_core.wasm & epoxy.wasm
    const coreWasmBytes = fs.readFileSync(path.join(PUBLIC_ASSETS, 'mc26_3_core.wasm'));
    const coreInst = new WebAssembly.Instance(new WebAssembly.Module(coreWasmBytes));
    const ex = coreInst.exports;
    const packed = ex.packBlockPos(-512, 127, 1024);
    if (
        ex.unpackBlockPosX(packed) !== -512 ||
        ex.unpackBlockPosY(packed) !== 127 ||
        ex.unpackBlockPosZ(packed) !== 1024
    ) {
        throw new Error('WASM BlockPos roundtrip failed');
    }
    const epoxyBytes = fs.readFileSync(path.join(PUBLIC_ASSETS, 'epoxy.wasm'));
    const epoxyMod = new WebAssembly.Module(epoxyBytes);
    console.log(`[PASS] WebAssembly modules verified: mc26_3_core.wasm (${coreWasmBytes.length}B) & epoxy.wasm (${epoxyBytes.length}B, ${WebAssembly.Module.exports(epoxyMod).length} exports).`);

    // 4. Verify Strict User Data Isolation (ensure zero forbidden files were copied into public/, dist/, or assets/)
    const forbiddenPatterns = ['saves', 'launcher_accounts', 'launcher_msa', 'launcher_profiles', 'options.txt', 'servers.dat'];
    function checkDirClean(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            for (const pat of forbiddenPatterns) {
                if (entry.name.toLowerCase().includes(pat)) {
                    throw new Error(`SECURITY VIOLATION: Forbidden file pattern "${pat}" found at ${path.join(dir, entry.name)}`);
                }
            }
            if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
                checkDirClean(path.join(dir, entry.name));
            }
        }
    }
    checkDirClean(PROJECT_DIR);
    console.log('[PASS] Strict User Data Isolation verified: zero user saves, credentials, or personal files in repository.');

    // 5. Execute Headless Worldgen, Spline Evaluation, Structure Placement, Chunk Meshing & Physics Tick
    const sandbox = {
        window: { addEventListener: () => {}, innerWidth: 1280, innerHeight: 720 },
        document: { addEventListener: () => {}, getElementById: () => null },
        performance: { now: () => Date.now() },
        navigator: { hardwareConcurrency: 4 },
        WebAssembly,
        Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
        DataView, ArrayBuffer, Map, Set, Math, BigInt, Number, String, Object, Array, Promise, Error,
        TextEncoder, TextDecoder, DecompressionStream, CompressionStream, Blob, Response,
        console, setTimeout, clearTimeout,
        __exports: {},
    };
    const testHarnessCode = bundleCode.replace(
        /\}\)\(\);\s*$/,
        '  __exports.WorldgenNoiseRouter = WorldgenNoiseRouter;\n' +
        '  __exports.ClientWorld = ClientWorld;\n' +
        '  __exports.ChunkMesher = ChunkMesher;\n' +
        '  __exports.JvmWasmCore = JvmWasmCore;\n' +
        '  __exports.parseStructureTemplateNbt = parseStructureTemplateNbt;\n' +
        '})();\n'
    );
    vm.runInNewContext(testHarnessCode, sandbox, { filename: 'bootstrap.js' });
    const { WorldgenNoiseRouter, ClientWorld, ChunkMesher, parseStructureTemplateNbt } = sandbox.__exports;
    const router = new WorldgenNoiseRouter(2632026n, wg);
    const world = new ClientWorld(reg.blocks, reg.biomes, router);
    const nbtBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_ASSETS, 'structures/abandoned_camp__camp__dappled_forest__campsite_dappled_forest_1.nbt')));
    const tmpl = await parseStructureTemplateNbt(nbtBytes);
    world.structures.set('abandoned_camp/campsite_dappled_forest_1', tmpl);
    const mesher = new ChunkMesher(world, reg.atlases.blocks.uvs);

    let totalOpaqueVerts = 0;
    let totalCutoutVerts = 0;
    let totalTranslucentVerts = 0;
    for (let cx = -2; cx <= 2; cx++) {
        for (let cz = -2; cz <= 2; cz++) {
            const col = world.getOrCreateChunk(cx, cz);
            const mesh = mesher.buildChunkMesh(col);
            totalOpaqueVerts += mesh.opaqueVertexCount;
            totalCutoutVerts += mesh.cutoutVertexCount;
            totalTranslucentVerts += mesh.translucentVertexCount;
        }
    }
    world.tick(8.5, 80.0, 8.5);
    if (totalOpaqueVerts === 0) {
        throw new Error('ChunkMesher produced 0 opaque vertices across 25 spawn chunks!');
    }
    console.log(
        `[PASS] Headless 25-chunk spawn generation & meshing succeeded: ` +
        `opaque=${totalOpaqueVerts} verts, cutout=${totalCutoutVerts} verts, translucent=${totalTranslucentVerts} verts, ` +
        `entities=${world.entities.size}.`
    );
    console.log('=== ALL CHECKS PASSED ===');
}

verifyAll().catch(err => {
    console.error(err);
    process.exit(1);
});
