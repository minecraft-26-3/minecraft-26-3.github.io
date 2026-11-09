/**
 * Minecraft 26.3 Chunk Mesher & Compact 32-Byte Vertex Packer
 *
 * Implements:
 * 1. Compact 32-byte (8 x 32-bit word) vertex packing (`x, y, z, u, v, normalPacked, lightPacked, rgbaColor`)
 *    matching `mc26_3_core.wasm`'s `packVertex` layout.
 * 2. Smooth Lighting / Per-Vertex Ambient Occlusion (AO) sampling 3 neighbor blocks per vertex corner.
 * 3. Biome Grass, Foliage, and Water colormap tinting (`grass_colormap.png` / `foliage_colormap.png` +
 *    26.3 biome hex overrides for `pale_garden`, `cherry_grove`, `sulfur_caves`, `dappled_forest`).
 * 4. Separate vertex streams per render pass:
 *    - Pass 1: Opaque Terrain (`renderLayer === 0`)
 *    - Pass 2: Cutout / Foliage / Crosses / Non-full blocks (`renderLayer === 1`)
 *    - Pass 3: Translucent Water & Stained Glass (`renderLayer === 2`), with per-quad centroid tracking
 *      for back-to-front depth sorting relative to the camera.
 * 5. 8-Level Fluid surface height interpolation (`fluidLevel / 9.0`).
 */

import { ChunkColumn, CHUNK_MIN_Y, CHUNK_MAX_Y, ClientWorld, BlockRegistryEntry } from '../world/physics_tick';

export interface AtlasUVEntry {
    x: number;
    y: number;
    w: number;
    h: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    frames: number;
    frametime: number;
    interpolate: boolean;
}

export interface TranslucentQuadRecord {
    cx: number;
    cy: number;
    cz: number;
    data: Uint32Array; // 6 vertices * 8 words = 48 uint32 words
}

export interface ChunkMeshBuffers {
    chunkX: number;
    chunkZ: number;
    opaqueData: Uint32Array;
    opaqueVertexCount: number;
    cutoutData: Uint32Array;
    cutoutVertexCount: number;
    translucentData: Uint32Array;
    translucentVertexCount: number;
    translucentQuads: TranslucentQuadRecord[];
}

export class GrowableVertexCollector {
    public u32: Uint32Array;
    public f32: Float32Array;
    public wordOffset = 0;

    constructor(initialVertices = 4096) {
        const buf = new ArrayBuffer(initialVertices * 32);
        this.u32 = new Uint32Array(buf);
        this.f32 = new Float32Array(buf);
    }

    private ensureCapacity(extraVertices: number): void {
        const neededWords = this.wordOffset + extraVertices * 8;
        if (neededWords <= this.u32.length) return;
        let newLen = this.u32.length * 2;
        while (newLen < neededWords) newLen *= 2;
        const nextBuf = new ArrayBuffer(newLen * 4);
        const nextU32 = new Uint32Array(nextBuf);
        nextU32.set(this.u32.subarray(0, this.wordOffset));
        this.u32 = nextU32;
        this.f32 = new Float32Array(nextBuf);
    }

    public pushVertex(
        x: number, y: number, z: number,
        u: number, v: number,
        normalPacked: number,
        lightPacked: number,
        colorPacked: number
    ): void {
        this.ensureCapacity(1);
        const o = this.wordOffset;
        this.f32[o] = x;
        this.f32[o + 1] = y;
        this.f32[o + 2] = z;
        this.f32[o + 3] = u;
        this.f32[o + 4] = v;
        this.u32[o + 5] = normalPacked >>> 0;
        this.u32[o + 6] = lightPacked >>> 0;
        this.u32[o + 7] = colorPacked >>> 0;
        this.wordOffset = o + 8;
    }

    public toTrimmedUint32(): Uint32Array {
        return this.u32.slice(0, this.wordOffset);
    }

    public get vertexCount(): number {
        return this.wordOffset >>> 3;
    }
}

export function packNormal(nx: number, ny: number, nz: number): number {
    const bx = Math.round(Math.max(-1, Math.min(1, nx)) * 127) & 0xff;
    const by = Math.round(Math.max(-1, Math.min(1, ny)) * 127) & 0xff;
    const bz = Math.round(Math.max(-1, Math.min(1, nz)) * 127) & 0xff;
    return bx | (by << 8) | (bz << 16);
}

export function packLightAndAO(blockLight: number, skyLight: number, aoFactor0to1: number): number {
    const bl = Math.max(0, Math.min(15, blockLight | 0));
    const sl = Math.max(0, Math.min(15, skyLight | 0));
    const ao = Math.max(0, Math.min(255, Math.round(aoFactor0to1 * 255)));
    return bl | (sl << 8) | (ao << 16);
}

export function packRGBA(r: number, g: number, b: number, a = 255): number {
    return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
}

export function unpackHexToRGBA(hex: number | string, alpha = 255): number {
    const num = typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) || 0xffffff : hex;
    const r = (num >>> 16) & 0xff;
    const g = (num >>> 8) & 0xff;
    const b = num & 0xff;
    return packRGBA(r, g, b, alpha);
}

const NORMAL_UP = packNormal(0, 1, 0);
const NORMAL_DOWN = packNormal(0, -1, 0);
const NORMAL_NORTH = packNormal(0, 0, -1);
const NORMAL_SOUTH = packNormal(0, 0, 1);
const NORMAL_EAST = packNormal(1, 0, 0);
const NORMAL_WEST = packNormal(-1, 0, 0);

export class ChunkMesher {
    private world: ClientWorld;
    private blockUvs: Record<string, AtlasUVEntry>;
    private defaultUv: AtlasUVEntry;

    constructor(world: ClientWorld, blockUvs: Record<string, AtlasUVEntry>) {
        this.world = world;
        this.blockUvs = blockUvs;
        this.defaultUv = blockUvs['stone'] || Object.values(blockUvs)[0] || {
            x: 0, y: 0, w: 16, h: 16, u0: 0, v0: 0, u1: 0.015625, v1: 0.03125, frames: 1, frametime: 1, interpolate: false,
        };
    }

    public getUV(texName: string): AtlasUVEntry {
        return this.blockUvs[texName] || this.blockUvs[texName + '_top'] || this.blockUvs[texName + '_side'] || this.defaultUv;
    }

    private isOccludingAt(wx: number, wy: number, wz: number): boolean {
        const entry = this.world.getBlockEntry(wx, wy, wz);
        return !entry.properties.air && entry.renderLayer === 0 && !entry.isCross && !entry.properties.noOcclusion;
    }

    /**
     * Computes smooth per-vertex Ambient Occlusion (AO) factor in `[0.45 .. 1.0]`
     * by checking the 2 side neighbors and 1 corner neighbor in the face tangent plane.
     */
    private sampleVertexAO(
        wx: number, wy: number, wz: number,
        s1x: number, s1y: number, s1z: number,
        s2x: number, s2y: number, s2z: number
    ): number {
        const side1 = this.isOccludingAt(wx + s1x, wy + s1y, wz + s1z) ? 1 : 0;
        const side2 = this.isOccludingAt(wx + s2x, wy + s2y, wz + s2z) ? 1 : 0;
        if (side1 && side2) return 0.48;
        const corner = this.isOccludingAt(wx + s1x + s2x, wy + s1y + s2y, wz + s1z + s2z) ? 1 : 0;
        const occluded = side1 + side2 + corner;
        return 1.0 - occluded * 0.16;
    }

    private getBiomeTintRGBA(col: ChunkColumn, lx: number, lz: number, block: BlockRegistryEntry, face: 'up' | 'side' | 'other'): number {
        const biomeId = col.biomes[(lz << 4) | lx];
        const biome = this.world.biomesById[biomeId];
        if (block.name === 'water') {
            const waterHex = biome?.effects?.water_color ?? 0x3f76e4;
            return unpackHexToRGBA(waterHex, 195);
        }
        if (block.name === 'grass_block') {
            if (face !== 'up') return 0xffffffff;
            const grassHex = biome?.effects?.grass_color ?? (biome?.name === 'pale_garden' ? 0x778272 : biome?.name === 'dappled_forest' ? 0x6ab84b : 0x7cbd46);
            return unpackHexToRGBA(grassHex, 255);
        }
        if (block.name === 'short_grass' || block.name.includes('fern') || block.name.includes('leaves')) {
            if (block.name === 'cherry_leaves') return unpackHexToRGBA(0xffb7e2, 255);
            if (block.name === 'pale_oak_leaves') return unpackHexToRGBA(0x879182, 255);
            const foliageHex = biome?.effects?.foliage_color ?? 0x59ae30;
            return unpackHexToRGBA(foliageHex, 255);
        }
        return block.renderLayer === 2 ? packRGBA(255, 255, 255, 190) : 0xffffffff;
    }

    private sampleLight(wx: number, wy: number, wz: number): { sky: number; block: number } {
        if (wy < CHUNK_MIN_Y) return { sky: 0, block: 0 };
        if (wy >= CHUNK_MAX_Y) return { sky: 15, block: 0 };
        const col = this.world.getChunk(wx >> 4, wz >> 4);
        if (!col) return { sky: 15, block: 0 };
        const lx = wx & 15;
        const lz = wz & 15;
        return {
            sky: col.getSkyLight(lx, wy, lz),
            block: col.getBlockLight(lx, wy, lz),
        };
    }

    /**
     * Meshes an entire 16x256x16 `ChunkColumn` into Opaque, Cutout, and Translucent vertex buffers.
     */
    public buildChunkMesh(col: ChunkColumn): ChunkMeshBuffers {
        const opaque = new GrowableVertexCollector(8192);
        const cutout = new GrowableVertexCollector(2048);
        const translucent = new GrowableVertexCollector(2048);
        const translucentQuads: TranslucentQuadRecord[] = [];

        const baseX = col.chunkX << 4;
        const baseZ = col.chunkZ << 4;

        for (let y = CHUNK_MIN_Y; y < CHUNK_MAX_Y; y++) {
            for (let lz = 0; lz < 16; lz++) {
                for (let lx = 0; lx < 16; lx++) {
                    const blockId = col.getBlock(lx, y, lz);
                    if (blockId === this.world.idAir) continue;
                    const block = this.world.blocksById[blockId];
                    if (!block || block.properties.air) continue;

                    const wx = baseX + lx;
                    const wz = baseZ + lz;

                    const targetCollector =
                        block.renderLayer === 2 ? translucent :
                        block.renderLayer === 1 ? cutout : opaque;

                    // Cross-model flora / torches / sulfur spikes (2 intersecting diagonal quads)
                    if (block.isCross) {
                        const uv = this.getUV(block.textures.north);
                        const lt = this.sampleLight(wx, y, wz);
                        const lp = packLightAndAO(Math.max(lt.block, block.lightEmission), lt.sky, 1.0);
                        const tint = this.getBiomeTintRGBA(col, lx, lz, block, 'up');
                        this.emitQuad(
                            cutout,
                            wx + 0.15, y, wz + 0.15,
                            wx + 0.85, y, wz + 0.85,
                            wx + 0.85, y + 1, wz + 0.85,
                            wx + 0.15, y + 1, wz + 0.15,
                            uv, NORMAL_UP, lp, lp, lp, lp, tint, true
                        );
                        this.emitQuad(
                            cutout,
                            wx + 0.15, y, wz + 0.85,
                            wx + 0.85, y, wz + 0.15,
                            wx + 0.85, y + 1, wz + 0.15,
                            wx + 0.15, y + 1, wz + 0.85,
                            uv, NORMAL_UP, lp, lp, lp, lp, tint, true
                        );
                        continue;
                    }

                    // Determine top Y height (8-level fluid height for water/lava or VoxelShape maxY)
                    let maxY = 1.0;
                    if (block.properties.liquid) {
                        const aboveId = this.world.getBlockId(wx, y + 1, wz);
                        if (aboveId !== blockId) {
                            const fLevel = col.getFluidLevel(lx, y, lz) || 8;
                            maxY = (fLevel / 9.0) * 0.98;
                        }
                    } else if (block.boxes.length === 1) {
                        maxY = block.boxes[0][4];
                    }

                    // Check each of the 6 faces for neighbor culling
                    // 1. UP (+Y)
                    if (this.shouldRenderFace(block, wx, y + 1, wz)) {
                        const uv = this.getUV(block.textures.up);
                        const lt = this.sampleLight(wx, y + 1, wz);
                        const em = Math.max(lt.block, block.lightEmission);
                        const ao00 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y + 1, wz, -1, 0, 0, 0, 0, -1));
                        const ao01 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y + 1, wz, -1, 0, 0, 0, 0, 1));
                        const ao11 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y + 1, wz, 1, 0, 0, 0, 0, 1));
                        const ao10 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y + 1, wz, 1, 0, 0, 0, 0, -1));
                        const tint = this.getBiomeTintRGBA(col, lx, lz, block, 'up');
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx, y + maxY, wz,
                            wx, y + maxY, wz + 1,
                            wx + 1, y + maxY, wz + 1,
                            wx + 1, y + maxY, wz,
                            uv, NORMAL_UP, ao00, ao01, ao11, ao10, tint
                        );
                    }

                    // 2. DOWN (-Y)
                    if (y > CHUNK_MIN_Y && this.shouldRenderFace(block, wx, y - 1, wz)) {
                        const uv = this.getUV(block.textures.down);
                        const lt = this.sampleLight(wx, y - 1, wz);
                        const em = Math.max(lt.block, block.lightEmission);
                        const lp = packLightAndAO(em, lt.sky, 0.85);
                        const tint = this.getBiomeTintRGBA(col, lx, lz, block, 'other');
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx, y, wz + 1,
                            wx, y, wz,
                            wx + 1, y, wz,
                            wx + 1, y, wz + 1,
                            uv, NORMAL_DOWN, lp, lp, lp, lp, tint
                        );
                    }

                    const sideTint = this.getBiomeTintRGBA(col, lx, lz, block, 'side');

                    // 3. NORTH (-Z)
                    if (this.shouldRenderFace(block, wx, y, wz - 1)) {
                        const uv = this.getUV(block.textures.north);
                        const lt = this.sampleLight(wx, y, wz - 1);
                        const em = Math.max(lt.block, block.lightEmission);
                        const ao0 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz - 1, 1, 0, 0, 0, -1, 0));
                        const ao1 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz - 1, -1, 0, 0, 0, -1, 0));
                        const ao2 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz - 1, -1, 0, 0, 0, 1, 0));
                        const ao3 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz - 1, 1, 0, 0, 0, 1, 0));
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx + 1, y, wz,
                            wx, y, wz,
                            wx, y + maxY, wz,
                            wx + 1, y + maxY, wz,
                            uv, NORMAL_NORTH, ao0, ao1, ao2, ao3, sideTint
                        );
                    }

                    // 4. SOUTH (+Z)
                    if (this.shouldRenderFace(block, wx, y, wz + 1)) {
                        const uv = this.getUV(block.textures.south);
                        const lt = this.sampleLight(wx, y, wz + 1);
                        const em = Math.max(lt.block, block.lightEmission);
                        const ao0 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz + 1, -1, 0, 0, 0, -1, 0));
                        const ao1 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz + 1, 1, 0, 0, 0, -1, 0));
                        const ao2 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz + 1, 1, 0, 0, 0, 1, 0));
                        const ao3 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx, y, wz + 1, -1, 0, 0, 0, 1, 0));
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx, y, wz + 1,
                            wx + 1, y, wz + 1,
                            wx + 1, y + maxY, wz + 1,
                            wx, y + maxY, wz + 1,
                            uv, NORMAL_SOUTH, ao0, ao1, ao2, ao3, sideTint
                        );
                    }

                    // 5. EAST (+X)
                    if (this.shouldRenderFace(block, wx + 1, y, wz)) {
                        const uv = this.getUV(block.textures.east);
                        const lt = this.sampleLight(wx + 1, y, wz);
                        const em = Math.max(lt.block, block.lightEmission);
                        const ao0 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx + 1, y, wz, 0, 0, 1, 0, -1, 0));
                        const ao1 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx + 1, y, wz, 0, 0, -1, 0, -1, 0));
                        const ao2 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx + 1, y, wz, 0, 0, -1, 0, 1, 0));
                        const ao3 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx + 1, y, wz, 0, 0, 1, 0, 1, 0));
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx + 1, y, wz + 1,
                            wx + 1, y, wz,
                            wx + 1, y + maxY, wz,
                            wx + 1, y + maxY, wz + 1,
                            uv, NORMAL_EAST, ao0, ao1, ao2, ao3, sideTint
                        );
                    }

                    // 6. WEST (-X)
                    if (this.shouldRenderFace(block, wx - 1, y, wz)) {
                        const uv = this.getUV(block.textures.west);
                        const lt = this.sampleLight(wx - 1, y, wz);
                        const em = Math.max(lt.block, block.lightEmission);
                        const ao0 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx - 1, y, wz, 0, 0, -1, 0, -1, 0));
                        const ao1 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx - 1, y, wz, 0, 0, 1, 0, -1, 0));
                        const ao2 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx - 1, y, wz, 0, 0, 1, 0, 1, 0));
                        const ao3 = packLightAndAO(em, lt.sky, this.sampleVertexAO(wx - 1, y, wz, 0, 0, -1, 0, 1, 0));
                        this.emitFaceOrRecordTranslucent(
                            targetCollector, block.renderLayer === 2 ? translucentQuads : null,
                            wx, y, wz,
                            wx, y, wz + 1,
                            wx, y + maxY, wz + 1,
                            wx, y + maxY, wz,
                            uv, NORMAL_WEST, ao0, ao1, ao2, ao3, sideTint
                        );
                    }
                }
            }
        }

        col.dirty = false;
        return {
            chunkX: col.chunkX,
            chunkZ: col.chunkZ,
            opaqueData: opaque.toTrimmedUint32(),
            opaqueVertexCount: opaque.vertexCount,
            cutoutData: cutout.toTrimmedUint32(),
            cutoutVertexCount: cutout.vertexCount,
            translucentData: translucent.toTrimmedUint32(),
            translucentVertexCount: translucent.vertexCount,
            translucentQuads,
        };
    }

    private shouldRenderFace(selfBlock: BlockRegistryEntry, nx: number, ny: number, nz: number): boolean {
        const neighbor = this.world.getBlockEntry(nx, ny, nz);
        if (!neighbor || neighbor.properties.air) return true;
        if (neighbor.rawId === selfBlock.rawId && (selfBlock.renderLayer === 2 || !selfBlock.name.includes('leaves'))) {
            return false;
        }
        if (neighbor.renderLayer !== 0 || neighbor.isCross || neighbor.properties.noOcclusion) {
            return true;
        }
        return false;
    }

    private emitFaceOrRecordTranslucent(
        collector: GrowableVertexCollector,
        translucentQuads: TranslucentQuadRecord[] | null,
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        x2: number, y2: number, z2: number,
        x3: number, y3: number, z3: number,
        uv: AtlasUVEntry,
        normalPacked: number,
        lp0: number, lp1: number, lp2: number, lp3: number,
        tint: number
    ): void {
        const startWord = collector.wordOffset;
        this.emitQuad(collector, x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, uv, normalPacked, lp0, lp1, lp2, lp3, tint, false);
        if (translucentQuads) {
            const quadWords = collector.u32.slice(startWord, collector.wordOffset);
            translucentQuads.push({
                cx: (x0 + x2) * 0.5,
                cy: (y0 + y2) * 0.5,
                cz: (z0 + z2) * 0.5,
                data: quadWords,
            });
        }
    }

    private emitQuad(
        c: GrowableVertexCollector,
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        x2: number, y2: number, z2: number,
        x3: number, y3: number, z3: number,
        uv: AtlasUVEntry,
        normalPacked: number,
        lp0: number, lp1: number, lp2: number, lp3: number,
        tint: number,
        doubleSided: boolean
    ): void {
        const u0 = uv.u0, v0 = uv.v1;
        const u1 = uv.u1, v1 = uv.v0;

        // Triangle 1: 0 -> 1 -> 2
        c.pushVertex(x0, y0, z0, u0, v0, normalPacked, lp0, tint);
        c.pushVertex(x1, y1, z1, u1, v0, normalPacked, lp1, tint);
        c.pushVertex(x2, y2, z2, u1, v1, normalPacked, lp2, tint);
        // Triangle 2: 0 -> 2 -> 3
        c.pushVertex(x0, y0, z0, u0, v0, normalPacked, lp0, tint);
        c.pushVertex(x2, y2, z2, u1, v1, normalPacked, lp2, tint);
        c.pushVertex(x3, y3, z3, u0, v1, normalPacked, lp3, tint);

        if (doubleSided) {
            c.pushVertex(x2, y2, z2, u1, v1, normalPacked, lp2, tint);
            c.pushVertex(x1, y1, z1, u1, v0, normalPacked, lp1, tint);
            c.pushVertex(x0, y0, z0, u0, v0, normalPacked, lp0, tint);

            c.pushVertex(x3, y3, z3, u0, v1, normalPacked, lp3, tint);
            c.pushVertex(x2, y2, z2, u1, v1, normalPacked, lp2, tint);
            c.pushVertex(x0, y0, z0, u0, v0, normalPacked, lp0, tint);
        }
    }

    /**
     * Sorts translucent quads back-to-front relative to `(camX, camY, camZ)`
     * so water, ice, and stained glass blend without depth-order artifacts.
     */
    public static sortTranslucentQuads(
        quads: TranslucentQuadRecord[],
        camX: number, camY: number, camZ: number
    ): Uint32Array {
        if (quads.length === 0) return new Uint32Array(0);
        const sorted = quads.slice().sort((a, b) => {
            const da = (a.cx - camX) ** 2 + (a.cy - camY) ** 2 + (a.cz - camZ) ** 2;
            const db = (b.cx - camX) ** 2 + (b.cy - camY) ** 2 + (b.cz - camZ) ** 2;
            return db - da;
        });
        const out = new Uint32Array(sorted.length * 48);
        let offset = 0;
        for (const q of sorted) {
            out.set(q.data, offset);
            offset += 48;
        }
        return out;
    }
}
