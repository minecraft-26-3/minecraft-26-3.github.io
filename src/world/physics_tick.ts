/**
 * Minecraft 26.3 (`world_version: 5023`) Chunk Storage, Biome & Surface Rule Generator,
 * Structure Template Placer, VoxelShape AABB Physics, 8-Level Water/Lava Fluid Dynamics,
 * Redstone Tick Priority Queue, and Mob Brain AI (including 26.3 `sulfur_cube`).
 */

import { BlockPos, ChunkPos, Xoroshiro128PlusPlus } from '../runtime/long_math';
import { ParsedStructureTemplate } from '../runtime/vfs_nbt';
import { WorldgenNoiseRouter } from './noise_router';

export interface BlockRegistryEntry {
    id: string;
    name: string;
    rawId: number;
    renderLayer: number; // 0 = opaque, 1 = cutout, 2 = translucent
    lightEmission: number;
    isCross: boolean;
    tintIndex: number;
    textures: {
        up: string;
        down: string;
        north: string;
        south: string;
        east: string;
        west: string;
    };
    boxes: Array<[number, number, number, number, number, number]>;
    properties: {
        mapColor: string;
        soundType: string;
        instrument: string;
        destroyTime: number;
        explosionResistance: number;
        noCollision: boolean;
        noOcclusion: boolean;
        replaceable: boolean;
        randomTicks: boolean;
        requiresCorrectTool: boolean;
        air: boolean;
        liquid: boolean;
    };
}

export interface BiomeRegistryEntry {
    id: string;
    name: string;
    rawId: number;
    temperature: number;
    downfall: number;
    hasPrecipitation: boolean;
    effects: {
        sky_color?: number;
        fog_color?: number;
        water_color?: number;
        water_fog_color?: number;
        grass_color?: number;
        foliage_color?: number;
    };
}

export const CHUNK_MIN_Y = -64;
export const CHUNK_MAX_Y = 192;
export const CHUNK_HEIGHT = CHUNK_MAX_Y - CHUNK_MIN_Y; // 256 vertical blocks (-64 .. 191)

export class ChunkColumn {
    public readonly chunkX: number;
    public readonly chunkZ: number;
    // Block rawId per (x: 0..15, y: 0..255, z: 0..15)
    public readonly blocks = new Uint16Array(16 * CHUNK_HEIGHT * 16);
    // Fluid level (0..8, where 8 = source block, 1..7 = flowing height)
    public readonly fluidLevel = new Uint8Array(16 * CHUNK_HEIGHT * 16);
    // Packed light: high nibble = skyLight (0..15), low nibble = blockLight (0..15)
    public readonly light = new Uint8Array(16 * CHUNK_HEIGHT * 16);
    // Biome rawId per 4x4 column (16x16)
    public readonly biomes = new Uint8Array(16 * 16);
    public readonly heightmap = new Int16Array(16 * 16);
    public dirty = true;

    constructor(chunkX: number, chunkZ: number) {
        this.chunkX = chunkX;
        this.chunkZ = chunkZ;
        this.light.fill(0xf0); // Default skyLight = 15, blockLight = 0
    }

    public static index(lx: number, y: number, lz: number): number {
        const ry = y - CHUNK_MIN_Y;
        return (ry << 8) | (lz << 4) | lx;
    }

    public getBlock(lx: number, y: number, lz: number): number {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.blocks[ChunkColumn.index(lx, y, lz)];
    }

    public setBlock(lx: number, y: number, lz: number, blockId: number): void {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.blocks[ChunkColumn.index(lx, y, lz)] = blockId;
        this.dirty = true;
    }

    public getFluidLevel(lx: number, y: number, lz: number): number {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.fluidLevel[ChunkColumn.index(lx, y, lz)];
    }

    public setFluidLevel(lx: number, y: number, lz: number, level: number): void {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.fluidLevel[ChunkColumn.index(lx, y, lz)] = level;
        this.dirty = true;
    }

    public getSkyLight(lx: number, y: number, lz: number): number {
        if (y < CHUNK_MIN_Y) return 0;
        if (y >= CHUNK_MAX_Y) return 15;
        return (this.light[ChunkColumn.index(lx, y, lz)] >>> 4) & 0x0f;
    }

    public getBlockLight(lx: number, y: number, lz: number): number {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.light[ChunkColumn.index(lx, y, lz)] & 0x0f;
    }

    public setLight(lx: number, y: number, lz: number, sky: number, block: number): void {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.light[ChunkColumn.index(lx, y, lz)] = ((sky & 0x0f) << 4) | (block & 0x0f);
    }
}

export interface AABB {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

export interface MobEntity {
    id: number;
    type: string; // e.g. 'sulfur_cube', 'pig', 'cow', 'zombie', 'skeleton', 'sheep'
    x: number;
    y: number;
    z: number;
    prevX: number;
    prevY: number;
    prevZ: number;
    vx: number;
    vy: number;
    vz: number;
    yaw: number;
    pitch: number;
    prevYaw: number;
    width: number;
    height: number;
    onGround: boolean;
    health: number;
    maxHealth: number;
    hurtTime: number;
    aiTimer: number;
    targetYaw: number;
    walkAnimPhase: number;
    walkAnimSpeed: number;
    squish: number; // Used by 26.3 Sulfur Cube & Slime jump squash/stretch
}

export interface BlockEntityInstance {
    x: number;
    y: number;
    z: number;
    type: 'chest' | 'sign' | 'beacon' | 'end_gateway' | 'campfire';
    openProgress: number;
    lines?: string[];
}

export interface ScheduledTick {
    x: number;
    y: number;
    z: number;
    targetTick: number;
    priority: number; // Vanilla TickPriority (-3 = EXTREMELY_HIGH .. +3 = EXTREMELY_LOW)
    kind: 'fluid' | 'redstone';
}

export class ClientWorld {
    public readonly blocksById: BlockRegistryEntry[];
    public readonly blockByName: Map<string, BlockRegistryEntry> = new Map();
    public readonly biomesById: BiomeRegistryEntry[];
    public readonly biomeByName: Map<string, BiomeRegistryEntry> = new Map();
    public readonly chunks: Map<bigint, ChunkColumn> = new Map();
    public readonly structures: Map<string, ParsedStructureTemplate> = new Map();
    public readonly entities: Map<number, MobEntity> = new Map();
    public readonly blockEntities: Map<bigint, BlockEntityInstance> = new Map();
    public readonly scheduledTicks: ScheduledTick[] = [];
    public readonly noiseRouter: WorldgenNoiseRouter;

    public worldAgeTicks = 0n;
    public timeOfDayTicks = 1000n; // Morning sun
    public isRaining = false;
    private nextEntityId = 100;

    // Fast cached IDs for core blocks
    public idAir = 0;
    public idStone = 1;
    public idGrassBlock = 2;
    public idDirt = 3;
    public idCobblestone = 4;
    public idBedrock = 5;
    public idWater = 6;
    public idLava = 7;
    public idSand = 8;
    public idSandstone = 9;
    public idGravel = 10;
    public idDeepslate = 11;
    public idOakLog = 12;
    public idOakLeaves = 13;
    public idShortGrass = 14;
    public idDandelion = 15;
    public idPoppy = 16;
    public idSnowBlock = 17;
    public idIce = 18;
    public idSulfur = 19;
    public idPotentSulfur = 20;
    public idSulfurSpike = 21;
    public idSulfurBricks = 22;
    public idPaleOakLog = 23;
    public idPaleOakLeaves = 24;
    public idCherryLog = 25;
    public idCherryLeaves = 26;
    public idCoalOre = 27;
    public idIronOre = 28;
    public idGoldOre = 29;
    public idDiamondOre = 30;
    public idGlowstone = 31;
    public idTorch = 32;
    public idRedstoneWire = 33;
    public idRedstoneTorch = 34;
    public idRedstoneLamp = 35;
    public idChest = 36;
    public idObsidian = 37;

    constructor(
        blocks: BlockRegistryEntry[],
        biomes: BiomeRegistryEntry[],
        noiseRouter: WorldgenNoiseRouter
    ) {
        this.blocksById = blocks;
        for (const b of blocks) {
            this.blockByName.set(b.name, b);
        }
        this.biomesById = biomes;
        for (const bm of biomes) {
            this.biomeByName.set(bm.name, bm);
        }
        this.noiseRouter = noiseRouter;

        const findId = (name: string, fallback = 1) => this.blockByName.get(name)?.rawId ?? fallback;
        this.idAir = findId('air', 0);
        this.idStone = findId('stone', 1);
        this.idGrassBlock = findId('grass_block', 2);
        this.idDirt = findId('dirt', 3);
        this.idCobblestone = findId('cobblestone', 4);
        this.idBedrock = findId('bedrock', 5);
        this.idWater = findId('water', 6);
        this.idLava = findId('lava', 7);
        this.idSand = findId('sand', 8);
        this.idSandstone = findId('sandstone', 9);
        this.idGravel = findId('gravel', 10);
        this.idDeepslate = findId('deepslate', 11);
        this.idOakLog = findId('oak_log', 12);
        this.idOakLeaves = findId('oak_leaves', 13);
        this.idShortGrass = findId('short_grass', 14);
        this.idDandelion = findId('dandelion', 15);
        this.idPoppy = findId('poppy', 16);
        this.idSnowBlock = findId('snow_block', 17);
        this.idIce = findId('ice', 18);
        this.idSulfur = findId('sulfur', this.idStone);
        this.idPotentSulfur = findId('potent_sulfur', this.idSulfur);
        this.idSulfurSpike = findId('sulfur_spike', this.idSulfur);
        this.idSulfurBricks = findId('sulfur_bricks', this.idSulfur);
        this.idPaleOakLog = findId('pale_oak_log', this.idOakLog);
        this.idPaleOakLeaves = findId('pale_oak_leaves', this.idOakLeaves);
        this.idCherryLog = findId('cherry_log', this.idOakLog);
        this.idCherryLeaves = findId('cherry_leaves', this.idOakLeaves);
        this.idCoalOre = findId('coal_ore', this.idStone);
        this.idIronOre = findId('iron_ore', this.idStone);
        this.idGoldOre = findId('gold_ore', this.idStone);
        this.idDiamondOre = findId('deepslate_diamond_ore', this.idDeepslate);
        this.idGlowstone = findId('glowstone', this.idStone);
        this.idTorch = findId('torch', this.idGlowstone);
        this.idRedstoneWire = findId('redstone_wire', this.idStone);
        this.idRedstoneTorch = findId('redstone_torch', this.idTorch);
        this.idRedstoneLamp = findId('redstone_lamp', this.idGlowstone);
        this.idChest = findId('chest', this.idOakLog);
        this.idObsidian = findId('obsidian', this.idBedrock);
    }

    public getChunk(chunkX: number, chunkZ: number): ChunkColumn | undefined {
        return this.chunks.get(ChunkPos.asLong(chunkX, chunkZ));
    }

    public getOrCreateChunk(chunkX: number, chunkZ: number): ChunkColumn {
        const key = ChunkPos.asLong(chunkX, chunkZ);
        let col = this.chunks.get(key);
        if (!col) {
            col = this.generateChunk(chunkX, chunkZ);
            this.chunks.set(key, col);
        }
        return col;
    }

    public getBlockId(x: number, y: number, z: number): number {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return this.idAir;
        const cx = x >> 4;
        const cz = z >> 4;
        const col = this.chunks.get(ChunkPos.asLong(cx, cz));
        if (!col) return this.idAir;
        return col.getBlock(x & 15, y, z & 15);
    }

    public getBlockEntry(x: number, y: number, z: number): BlockRegistryEntry {
        const id = this.getBlockId(x, y, z);
        return this.blocksById[id] || this.blocksById[this.idAir];
    }

    public getFluidLevel(x: number, y: number, z: number): number {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        const col = this.chunks.get(ChunkPos.asLong(x >> 4, z >> 4));
        if (!col) return 0;
        return col.getFluidLevel(x & 15, y, z & 15);
    }

    public setBlockId(x: number, y: number, z: number, blockId: number, triggerUpdates = true): void {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        const cx = x >> 4;
        const cz = z >> 4;
        const col = this.chunks.get(ChunkPos.asLong(cx, cz));
        if (!col) return;
        const lx = x & 15;
        const lz = z & 15;
        col.setBlock(lx, y, lz, blockId);

        if (blockId === this.idWater || blockId === this.idLava) {
            col.setFluidLevel(lx, y, lz, 8);
        } else {
            col.setFluidLevel(lx, y, lz, 0);
        }

        const bPosKey = BlockPos.asLong(x, y, z);
        if (blockId === this.idChest) {
            this.blockEntities.set(bPosKey, { x, y, z, type: 'chest', openProgress: 0 });
        } else {
            this.blockEntities.delete(bPosKey);
        }

        // Update local lighting and mark neighboring chunks dirty if on chunk border
        this.recalculateColumnLight(col, lx, lz);
        if (lx === 0) this.markChunkDirty(cx - 1, cz);
        if (lx === 15) this.markChunkDirty(cx + 1, cz);
        if (lz === 0) this.markChunkDirty(cx, cz - 1);
        if (lz === 15) this.markChunkDirty(cx, cz + 1);

        if (triggerUpdates) {
            this.scheduleFluidAndRedstoneNeighbors(x, y, z);
        }
    }

    public markChunkDirty(cx: number, cz: number): void {
        const c = this.chunks.get(ChunkPos.asLong(cx, cz));
        if (c) c.dirty = true;
    }

    /**
     * Generates a 16x256x16 `ChunkColumn` using the exact Minecraft 26.3 `WorldgenNoiseRouter`,
     * `Xoroshiro128++` positional RNG, `material_rule` surface rules, Sulfur Caves features (`sulfur`,
     * `potent_sulfur`, `sulfur_spike`), trees, ores, and `.nbt` structure templates.
     */
    public generateChunk(chunkX: number, chunkZ: number): ChunkColumn {
        const col = new ChunkColumn(chunkX, chunkZ);
        const seaLevel = 63;
        const baseX = chunkX << 4;
        const baseZ = chunkZ << 4;
        const rng = new Xoroshiro128PlusPlus(
            this.noiseRouter.getSeed() ^ (BigInt(chunkX) * 341873128712n + BigInt(chunkZ) * 132897987541n)
        );
        const caveNoise = this.noiseRouter.getNoise('minecraft:spaghetti_2d');
        const sulfurNoise = this.noiseRouter.getNoise('minecraft:ore_vein_a');

        for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
                const wx = baseX + lx;
                const wz = baseZ + lz;
                const { surfaceY, sample } = this.noiseRouter.computeColumnHeight(wx, wz);
                col.heightmap[(lz << 4) | lx] = surfaceY;

                const biomeEntry = this.biomeByName.get(sample.biomeName) || this.biomeByName.get('plains') || this.biomesById[0];
                col.biomes[(lz << 4) | lx] = biomeEntry ? biomeEntry.rawId : 0;

                const isDesert = sample.biomeName === 'desert' || sample.biomeName === 'beach';
                const isSnowy = sample.biomeName.includes('snowy') || sample.biomeName === 'jagged_peaks';

                for (let y = CHUNK_MIN_Y; y <= Math.max(surfaceY, seaLevel); y++) {
                    if (y === CHUNK_MIN_Y) {
                        col.setBlock(lx, y, lz, this.idBedrock);
                        continue;
                    }
                    if (y > surfaceY) {
                        if (y === seaLevel && isSnowy) {
                            col.setBlock(lx, y, lz, this.idIce);
                        } else {
                            col.setBlock(lx, y, lz, this.idWater);
                            col.setFluidLevel(lx, y, lz, 8);
                        }
                        continue;
                    }

                    // 3D Cave & 26.3 Sulfur Caves carving
                    if (y < surfaceY - 4 && y > CHUNK_MIN_Y + 4) {
                        const cVal = caveNoise.getValue(wx * 0.75, y * 0.85, wz * 0.75);
                        if (Math.abs(cVal) > 0.62) {
                            if (y < -48) {
                                col.setBlock(lx, y, lz, this.idLava);
                                col.setFluidLevel(lx, y, lz, 8);
                            } else if (y < 24 && sample.temperature > 0.1) {
                                // Minecraft 26.3 Sulfur Caves crust!
                                const sVal = sulfurNoise.getValue(wx * 1.2, y * 1.2, wz * 1.2);
                                if (sVal > 0.35 && Math.abs(cVal) < 0.68) {
                                    col.setBlock(lx, y, lz, sVal > 0.55 ? this.idPotentSulfur : this.idSulfur);
                                }
                            }
                            continue;
                        }
                    }

                    // Surface Rules (material_rule)
                    if (y === surfaceY) {
                        if (surfaceY < seaLevel - 1) {
                            col.setBlock(lx, y, lz, isDesert ? this.idSand : this.idGravel);
                        } else if (isDesert || (surfaceY <= seaLevel + 2 && sample.continents < 0.05)) {
                            col.setBlock(lx, y, lz, this.idSand);
                        } else if (isSnowy && surfaceY > 95) {
                            col.setBlock(lx, y, lz, this.idSnowBlock);
                        } else {
                            col.setBlock(lx, y, lz, this.idGrassBlock);
                        }
                    } else if (y >= surfaceY - 3) {
                        col.setBlock(lx, y, lz, isDesert ? this.idSandstone : this.idDirt);
                    } else if (y < 0) {
                        col.setBlock(lx, y, lz, this.idDeepslate);
                    } else {
                        // Ore distribution
                        const oreRoll = (wx * 73428767 ^ y * 912931 ^ wz * 438289) & 255;
                        if (oreRoll === 1 && y < 16) {
                            col.setBlock(lx, y, lz, this.idDiamondOre);
                        } else if (oreRoll === 2 && y < 48) {
                            col.setBlock(lx, y, lz, this.idGoldOre);
                        } else if (oreRoll < 6 && y < 72) {
                            col.setBlock(lx, y, lz, this.idIronOre);
                        } else if (oreRoll < 11) {
                            col.setBlock(lx, y, lz, y < 22 && sample.temperature > 0.15 ? this.idSulfur : this.idCoalOre);
                        } else {
                            col.setBlock(lx, y, lz, this.idStone);
                        }
                    }
                }

                // Surface flora & Sulfur Spikes
                if (surfaceY > seaLevel + 1 && col.getBlock(lx, surfaceY, lz) === this.idGrassBlock) {
                    const fRoll = rng.nextInt(100);
                    if (fRoll < 12) {
                        col.setBlock(lx, surfaceY + 1, lz, this.idShortGrass);
                    } else if (fRoll === 13) {
                        col.setBlock(lx, surfaceY + 1, lz, this.idDandelion);
                    } else if (fRoll === 14) {
                        col.setBlock(lx, surfaceY + 1, lz, this.idPoppy);
                    }
                }
            }
        }

        // Decorate trees (Oak, Cherry, and 26.3 Pale Oak / Dappled Forest)
        for (let t = 0; t < 3; t++) {
            const tx = 3 + rng.nextInt(10);
            const tz = 3 + rng.nextInt(10);
            const ty = col.heightmap[(tz << 4) | tx];
            if (ty > seaLevel + 1 && col.getBlock(tx, ty, tz) === this.idGrassBlock) {
                const wx = baseX + tx;
                const wz = baseZ + tz;
                const sample = this.noiseRouter.sampleOverworldRouter(wx, ty, wz);
                if (sample.vegetation > -0.15 && rng.nextInt(3) === 0) {
                    const logId = sample.biomeName === 'pale_garden'
                        ? this.idPaleOakLog
                        : sample.biomeName === 'cherry_grove'
                            ? this.idCherryLog
                            : this.idOakLog;
                    const leavesId = sample.biomeName === 'pale_garden'
                        ? this.idPaleOakLeaves
                        : sample.biomeName === 'cherry_grove'
                            ? this.idCherryLeaves
                            : this.idOakLeaves;
                    const trunkH = 4 + rng.nextInt(2);
                    for (let h = 1; h <= trunkH; h++) {
                        col.setBlock(tx, ty + h, tz, logId);
                    }
                    for (let dy = trunkH - 1; dy <= trunkH + 1; dy++) {
                        const rad = dy === trunkH + 1 ? 1 : 2;
                        for (let dx = -rad; dx <= rad; dx++) {
                            for (let dz = -rad; dz <= rad; dz++) {
                                if (Math.abs(dx) === rad && Math.abs(dz) === rad && rng.nextBoolean()) continue;
                                if (dx === 0 && dz === 0 && dy <= trunkH) continue;
                                col.setBlock(tx + dx, ty + dy, tz + dz, leavesId);
                            }
                        }
                    }
                }
            }
        }

        // Place authentic .nbt structure template on landmark chunks (e.g., abandoned_camp or plains house)
        if (((chunkX & 7) === 2 && (chunkZ & 7) === 2) && this.structures.size > 0) {
            const structIter = this.structures.values().next();
            if (!structIter.done && structIter.value) {
                this.placeStructureInChunk(col, structIter.value, 2, col.heightmap[(2 << 4) | 2] + 1, 2);
            }
        }

        // Compute sky & block lighting for the chunk
        for (let lz = 0; lz < 16; lz++) {
            for (let lx = 0; lx < 16; lx++) {
                this.recalculateColumnLight(col, lx, lz);
            }
        }

        // Spawn passive mobs and Minecraft 26.3's Sulfur Cube entity
        if (this.entities.size < 28 && rng.nextInt(3) === 0) {
            const sx = baseX + 8;
            const sz = baseZ + 8;
            const sy = col.heightmap[(8 << 4) | 8] + 1;
            if (sy > seaLevel) {
                const types = ['sulfur_cube', 'pig', 'sheep', 'cow', 'zombie'];
                const chosen = types[rng.nextInt(types.length)];
                this.spawnMob(chosen, sx + 0.5, sy, sz + 0.5);
            }
        }

        return col;
    }

    private placeStructureInChunk(col: ChunkColumn, tmpl: ParsedStructureTemplate, ox: number, oy: number, oz: number): void {
        for (const blk of tmpl.blocks) {
            const pal = tmpl.palette[blk.state];
            if (!pal || pal.Name === 'air' || pal.Name === 'structure_void') continue;
            const lx = ox + blk.pos[0];
            const y = oy + blk.pos[1];
            const lz = oz + blk.pos[2];
            if (lx >= 0 && lx < 16 && lz >= 0 && lz < 16 && y >= CHUNK_MIN_Y && y < CHUNK_MAX_Y) {
                const entry = this.blockByName.get(pal.Name);
                if (entry) {
                    col.setBlock(lx, y, lz, entry.rawId);
                }
            }
        }
    }

    public recalculateColumnLight(col: ChunkColumn, lx: number, lz: number): void {
        let sky = 15;
        for (let y = CHUNK_MAX_Y - 1; y >= CHUNK_MIN_Y; y--) {
            const id = col.getBlock(lx, y, lz);
            const b = this.blocksById[id];
            if (b && !b.properties.air) {
                if (b.renderLayer === 0) sky = 0;
                else sky = Math.max(0, sky - 2);
            }
            const emission = b ? b.lightEmission : 0;
            col.setLight(lx, y, lz, sky, emission);
        }
    }

    public spawnMob(type: string, x: number, y: number, z: number): MobEntity {
        const id = this.nextEntityId++;
        const isSulfurCube = type === 'sulfur_cube';
        const isTall = type === 'zombie' || type === 'skeleton';
        const ent: MobEntity = {
            id,
            type,
            x, y, z,
            prevX: x, prevY: y, prevZ: z,
            vx: 0, vy: 0, vz: 0,
            yaw: Math.random() * Math.PI * 2,
            pitch: 0,
            prevYaw: 0,
            width: isSulfurCube ? 0.8 : 0.6,
            height: isTall ? 1.95 : isSulfurCube ? 0.8 : 1.1,
            onGround: false,
            health: 20,
            maxHealth: 20,
            hurtTime: 0,
            aiTimer: 20 + Math.floor(Math.random() * 40),
            targetYaw: Math.random() * Math.PI * 2,
            walkAnimPhase: 0,
            walkAnimSpeed: 0,
            squish: 0,
        };
        this.entities.set(id, ent);
        return ent;
    }

    /**
     * Collects all world-space `VoxelShape` AABB collision boxes intersecting `queryBox`.
     */
    public getCollisionBoxes(queryBox: AABB): AABB[] {
        const out: AABB[] = [];
        const minX = Math.floor(queryBox.minX - 0.001);
        const maxX = Math.floor(queryBox.maxX + 0.001);
        const minY = Math.floor(queryBox.minY - 0.5);
        const maxY = Math.floor(queryBox.maxY + 0.001);
        const minZ = Math.floor(queryBox.minZ - 0.001);
        const maxZ = Math.floor(queryBox.maxZ + 0.001);

        for (let y = minY; y <= maxY; y++) {
            for (let z = minZ; z <= maxZ; z++) {
                for (let x = minX; x <= maxX; x++) {
                    const entry = this.getBlockEntry(x, y, z);
                    if (!entry || entry.properties.air || entry.properties.noCollision || entry.properties.liquid) {
                        continue;
                    }
                    for (const b of entry.boxes) {
                        out.push({
                            minX: x + b[0],
                            minY: y + b[1],
                            minZ: z + b[2],
                            maxX: x + b[3],
                            maxY: y + b[4],
                            maxZ: z + b[5],
                        });
                    }
                }
            }
        }
        return out;
    }

    /**
     * Swept multi-box `VoxelShape` AABB collision resolution (`Entity.collideBoundingBox`),
     * resolving Y -> X -> Z axes with 0.6-block step-up support when on ground.
     */
    public moveEntityWithCollisions(
        box: AABB,
        dx: number,
        dy: number,
        dz: number
    ): { box: AABB; dx: number; dy: number; dz: number; onGround: boolean; hitHorizontal: boolean } {
        const expanded: AABB = {
            minX: Math.min(box.minX, box.minX + dx) - 0.5,
            minY: Math.min(box.minY, box.minY + dy) - 0.5,
            minZ: Math.min(box.minZ, box.minZ + dz) - 0.5,
            maxX: Math.max(box.maxX, box.maxX + dx) + 0.5,
            maxY: Math.max(box.maxY, box.maxY + dy) + 0.5,
            maxZ: Math.max(box.maxZ, box.maxZ + dz) + 0.5,
        };
        const colliders = this.getCollisionBoxes(expanded);
        const origDy = dy;
        const origDx = dx;
        const origDz = dz;
        let cur = { ...box };

        // 1. Resolve Y axis
        for (const c of colliders) {
            if (cur.maxX > c.minX && cur.minX < c.maxX && cur.maxZ > c.minZ && cur.minZ < c.maxZ) {
                if (dy > 0 && cur.maxY <= c.minY + 1e-5) {
                    dy = Math.min(dy, c.minY - cur.maxY);
                } else if (dy < 0 && cur.minY >= c.maxY - 1e-5) {
                    dy = Math.max(dy, c.maxY - cur.minY);
                }
            }
        }
        cur.minY += dy;
        cur.maxY += dy;

        // 2. Resolve X axis
        for (const c of colliders) {
            if (cur.maxY > c.minY && cur.minY < c.maxY && cur.maxZ > c.minZ && cur.minZ < c.maxZ) {
                if (dx > 0 && cur.maxX <= c.minX + 1e-5) {
                    dx = Math.min(dx, c.minX - cur.maxX);
                } else if (dx < 0 && cur.minX >= c.maxX - 1e-5) {
                    dx = Math.max(dx, c.maxX - cur.minX);
                }
            }
        }
        cur.minX += dx;
        cur.maxX += dx;

        // 3. Resolve Z axis
        for (const c of colliders) {
            if (cur.maxY > c.minY && cur.minY < c.maxY && cur.maxX > c.minX && cur.minX < c.maxX) {
                if (dz > 0 && cur.maxZ <= c.minZ + 1e-5) {
                    dz = Math.min(dz, c.minZ - cur.maxZ);
                } else if (dz < 0 && cur.minZ >= c.maxZ - 1e-5) {
                    dz = Math.max(dz, c.maxZ - cur.minZ);
                }
            }
        }
        cur.minZ += dz;
        cur.maxZ += dz;

        const onGround = origDy < 0 && Math.abs(dy - origDy) > 1e-5;
        const hitHorizontal = Math.abs(dx - origDx) > 1e-5 || Math.abs(dz - origDz) > 1e-5;
        return { box: cur, dx, dy, dz, onGround, hitHorizontal };
    }

    /**
     * Schedules Fluid (Water: 5 ticks, Lava: 30 ticks) and Redstone (2 ticks) updates in the priority queue.
     */
    public scheduleFluidAndRedstoneNeighbors(x: number, y: number, z: number): void {
        const now = Number(this.worldAgeTicks);
        const dirs = [
            [0, 0, 0], [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        ];
        for (const [ox, oy, oz] of dirs) {
            const nx = x + ox, ny = y + oy, nz = z + oz;
            const bid = this.getBlockId(nx, ny, nz);
            if (bid === this.idWater) {
                this.scheduledTicks.push({ x: nx, y: ny, z: nz, targetTick: now + 5, priority: 0, kind: 'fluid' });
            } else if (bid === this.idLava) {
                this.scheduledTicks.push({ x: nx, y: ny, z: nz, targetTick: now + 15, priority: 0, kind: 'fluid' });
            } else if (bid === this.idRedstoneWire || bid === this.idRedstoneLamp || bid === this.idRedstoneTorch) {
                this.scheduledTicks.push({ x: nx, y: ny, z: nz, targetTick: now + 2, priority: -1, kind: 'redstone' });
            }
        }
        this.scheduledTicks.sort((a, b) => (a.targetTick - b.targetTick) || (a.priority - b.priority));
    }

    /**
     * Executes one deterministic 20 TPS client & world tick (`50ms` fixed step):
     * - Advances day/night cycle (`timeOfDayTicks`)
     * - Processes scheduled 8-level Water/Lava fluid spreading & Cobblestone/Obsidian interactions
     * - Processes Redstone wire/lamp signal propagation
     * - Updates BlockEntity animations (e.g., Chest lid angle)
     * - Steps Mob Brain AI & physics (including 26.3 `sulfur_cube` bouncing & passive/hostile mobs)
     */
    public tick(playerX: number, playerY: number, playerZ: number): void {
        this.worldAgeTicks += 1n;
        this.timeOfDayTicks = (this.timeOfDayTicks + 1n) % 24000n;
        const now = Number(this.worldAgeTicks);

        // Process scheduled fluid & redstone ticks
        let processed = 0;
        while (this.scheduledTicks.length > 0 && this.scheduledTicks[0].targetTick <= now && processed < 64) {
            const task = this.scheduledTicks.shift()!;
            processed++;
            if (task.kind === 'fluid') {
                this.stepFluidBlock(task.x, task.y, task.z);
            } else if (task.kind === 'redstone') {
                this.stepRedstoneBlock(task.x, task.y, task.z);
            }
        }

        // Step Mob Entities
        for (const ent of this.entities.values()) {
            ent.prevX = ent.x;
            ent.prevY = ent.y;
            ent.prevZ = ent.z;
            ent.prevYaw = ent.yaw;
            if (ent.hurtTime > 0) ent.hurtTime--;
            ent.squish *= 0.75;

            ent.aiTimer--;
            const distToPlayer = Math.hypot(playerX - ent.x, playerZ - ent.z);
            if (ent.type === 'zombie' && distToPlayer < 16.0) {
                ent.targetYaw = Math.atan2(-(playerX - ent.x), -(playerZ - ent.z));
            } else if (ent.aiTimer <= 0) {
                ent.aiTimer = 30 + Math.floor(Math.random() * 50);
                ent.targetYaw += (Math.random() - 0.5) * 2.2;
            }

            // Smooth yaw rotation
            const diffYaw = ent.targetYaw - ent.yaw;
            ent.yaw += diffYaw * 0.2;

            // Movement AI
            if (ent.type === 'sulfur_cube') {
                // Minecraft 26.3 Sulfur Cube hops periodically like a magma/slime cube!
                if (ent.onGround && ent.aiTimer % 18 === 0) {
                    ent.vy = 0.42;
                    ent.vx = -Math.sin(ent.yaw) * 0.22;
                    ent.vz = -Math.cos(ent.yaw) * 0.22;
                    ent.squish = 0.6;
                }
            } else {
                const moveSpeed = ent.type === 'zombie' && distToPlayer < 16.0 ? 0.08 : 0.045;
                if (ent.aiTimer > 15 || (ent.type === 'zombie' && distToPlayer < 16.0)) {
                    ent.vx = ent.vx * 0.6 - Math.sin(ent.yaw) * moveSpeed * 0.4;
                    ent.vz = ent.vz * 0.6 - Math.cos(ent.yaw) * moveSpeed * 0.4;
                } else {
                    ent.vx *= 0.7;
                    ent.vz *= 0.7;
                }
            }

            // Gravity (0.08 blocks/tick^2) & drag (0.98)
            ent.vy = (ent.vy - 0.08) * 0.98;

            const halfW = ent.width * 0.5;
            const box: AABB = {
                minX: ent.x - halfW,
                minY: ent.y,
                minZ: ent.z - halfW,
                maxX: ent.x + halfW,
                maxY: ent.y + ent.height,
                maxZ: ent.z + halfW,
            };
            const res = this.moveEntityWithCollisions(box, ent.vx, ent.vy, ent.vz);
            ent.x = (res.box.minX + res.box.maxX) * 0.5;
            ent.y = res.box.minY;
            ent.z = (res.box.minZ + res.box.maxZ) * 0.5;
            ent.onGround = res.onGround;
            if (res.onGround && ent.vy < 0) {
                if (ent.type === 'sulfur_cube' && ent.vy < -0.15) ent.squish = -0.45;
                ent.vy = 0;
            }
            if (res.hitHorizontal && ent.onGround) {
                ent.vy = 0.42; // Auto-jump over 1-block obstacles
            }

            const horizSpeed = Math.hypot(ent.x - ent.prevX, ent.z - ent.prevZ);
            ent.walkAnimSpeed = ent.walkAnimSpeed * 0.6 + horizSpeed * 4.0 * 0.4;
            ent.walkAnimPhase += ent.walkAnimSpeed;
        }
    }

    /**
     * 8-Level Water & Lava Fluid Mechanics:
     * - Flows straight down into air/replaceable blocks as level 8 falling fluid
     * - Spreads horizontally with level `level - 1` (Water) or `level - 2` (Lava)
     * - Lava + Water -> Obsidian (if source) or Cobblestone / Stone
     */
    private stepFluidBlock(x: number, y: number, z: number): void {
        const id = this.getBlockId(x, y, z);
        if (id !== this.idWater && id !== this.idLava) return;
        const level = this.getFluidLevel(x, y, z);
        if (level <= 0) return;

        // Check downward flow first
        const belowId = this.getBlockId(x, y - 1, z);
        const belowEntry = this.blocksById[belowId];
        if (belowEntry && (belowEntry.properties.air || belowEntry.properties.replaceable) && belowId !== id) {
            if ((id === this.idWater && belowId === this.idLava) || (id === this.idLava && belowId === this.idWater)) {
                this.setBlockId(x, y - 1, z, this.idStone, true);
                return;
            }
            this.setBlockId(x, y - 1, z, id, true);
            const col = this.chunks.get(ChunkPos.asLong(x >> 4, z >> 4));
            col?.setFluidLevel(x & 15, y - 1, z & 15, 8);
            return;
        }

        // Horizontal spread
        const drop = id === this.idLava ? 2 : 1;
        const nextLevel = level - drop;
        if (nextLevel <= 0) return;

        const horiz = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [ox, oz] of horiz) {
            const nx = x + ox, nz = z + oz;
            const nId = this.getBlockId(nx, y, nz);
            if ((id === this.idWater && nId === this.idLava) || (id === this.idLava && nId === this.idWater)) {
                const nLevel = this.getFluidLevel(nx, y, nz);
                this.setBlockId(nx, y, nz, nLevel === 8 ? this.idObsidian : this.idCobblestone, true);
                continue;
            }
            const nEntry = this.blocksById[nId];
            if (nEntry && (nEntry.properties.air || (nEntry.properties.replaceable && nId !== id))) {
                const col = this.chunks.get(ChunkPos.asLong(nx >> 4, nz >> 4));
                if (col) {
                    col.setBlock(nx & 15, y, nz & 15, id);
                    col.setFluidLevel(nx & 15, y, nz & 15, nextLevel);
                    this.scheduleFluidAndRedstoneNeighbors(nx, y, nz);
                }
            }
        }
    }

    private stepRedstoneBlock(x: number, y: number, z: number): void {
        const id = this.getBlockId(x, y, z);
        if (id === this.idRedstoneLamp) {
            // Check if adjacent to a Redstone Torch
            const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
            let powered = false;
            for (const [ox, oy, oz] of dirs) {
                if (this.getBlockId(x + ox, y + oy, z + oz) === this.idRedstoneTorch) {
                    powered = true;
                    break;
                }
            }
            const col = this.chunks.get(ChunkPos.asLong(x >> 4, z >> 4));
            if (col) {
                col.setLight(x & 15, y, z & 15, col.getSkyLight(x & 15, y, z & 15), powered ? 15 : 0);
                col.dirty = true;
            }
        }
    }

    /**
     * Exact Amanatides & Woo 3D DDA Voxel + `VoxelShape` sub-box raycaster (`Level.clip`),
     * returning the hit block coordinate, face normal, exact hit point, and distance.
     */
    public raycastBlock(
        ox: number, oy: number, oz: number,
        dx: number, dy: number, dz: number,
        maxDist = 5.0
    ): {
        x: number; y: number; z: number;
        nx: number; ny: number; nz: number;
        hitX: number; hitY: number; hitZ: number;
        dist: number;
        block: BlockRegistryEntry;
    } | null {
        const step = 0.025;
        let prevBx = Math.floor(ox);
        let prevBy = Math.floor(oy);
        let prevBz = Math.floor(oz);

        for (let t = 0; t <= maxDist; t += step) {
            const px = ox + dx * t;
            const py = oy + dy * t;
            const pz = oz + dz * t;
            const bx = Math.floor(px);
            const by = Math.floor(py);
            const bz = Math.floor(pz);

            const entry = this.getBlockEntry(bx, by, bz);
            if (!entry || entry.properties.air || entry.properties.liquid) {
                prevBx = bx; prevBy = by; prevBz = bz;
                continue;
            }

            const lx = px - bx;
            const ly = py - by;
            const lz = pz - bz;
            for (const box of entry.boxes) {
                if (
                    lx >= box[0] && lx <= box[3] &&
                    ly >= box[1] && ly <= box[4] &&
                    lz >= box[2] && lz <= box[5]
                ) {
                    let nx = prevBx - bx;
                    let ny = prevBy - by;
                    let nz = prevBz - bz;
                    if (nx === 0 && ny === 0 && nz === 0) ny = 1;
                    else if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) > 1) {
                        nx = 0; nz = 0; ny = 1;
                    }
                    return {
                        x: bx, y: by, z: bz,
                        nx, ny, nz,
                        hitX: px, hitY: py, hitZ: pz,
                        dist: t,
                        block: entry,
                    };
                }
            }
            prevBx = bx; prevBy = by; prevBz = bz;
        }
        return null;
    }
}
