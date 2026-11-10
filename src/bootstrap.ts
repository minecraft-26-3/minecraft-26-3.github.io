/**
 * Minecraft 26.3 (`protocol_version: 777`, `world_version: 5023`) Browser Client Bootstrap
 *
 * Orchestrates:
 * 1. Authentic Boot Sequence: `Main.main()` -> `SplashOverlay` (`LoadingOverlay`) -> `TitleScreen`
 *    with 6-face rotating Panorama cubemap (`panorama_0.png`..`panorama_5.png`), `minecraft.png` logo,
 *    and bouncing yellow splash text from `splashes.txt`.
 * 2. JVM Classfile v69.0 Bytecode Transpilation Engine (`bytecode_gui.json`) & Platform Abstraction
 *    Layer (`PlatformAbstractionLayer`) with persistent `options.txt`, 143-language `I18n`,
 *    IndexedDB/OPFS Singleplayer World Management, and `.zip` Resource Pack loader.
 * 3. Full Vanilla Screen Hierarchy (`VanillaScreenManager`): `TitleScreen`, `SelectWorldScreen`,
 *    `CreateWorldScreen` (`Game`, `World`, `More` tabs), `CreateFlatWorldScreen`, `PresetFlatWorldScreen`,
 *    `CreateBuffetWorldScreen`, `WorldCreationGameRulesScreen`, `ExperimentsScreen`, `OptionsScreen`,
 *    `VideoSettingsScreen`, `SoundOptionsScreen`, `ControlsScreen`, `MouseSettingsScreen`, `KeyBindsScreen`,
 *    `LanguageSelectScreen`, `PackSelectionScreen`, `SkinCustomizationScreen`, `ChatOptionsScreen`,
 *    `AccessibilityOptionsScreen`, `PauseScreen`, `AdvancementsScreen`, `StatsScreen`, `ShareToLanScreen`,
 *    and `CreativeModeInventoryScreen`.
 * 4. Dual WebGPU (Primary) / WebGL2 (Fallback) Rendering Engine & Fixed 20 TPS (50ms) Client Tick Loop.
 */

import { JvmWasmCore } from './wasm/jvm_core';
import { ChunkPos } from './runtime/long_math';
import { BrowserVFS, StructureTemplateData, parseStructureTemplateNbt } from './runtime/vfs_nbt';
import { OpenALAudioEngine, SoundSource } from './runtime/openal_audio';
import { ThreadedWorkerPool } from './runtime/worker_pool';
import { PlatformAbstractionLayer, SavedWorldSummary } from './runtime/pal';
import { WispEpoxyClient } from './network/wisp_epoxy';
import { MicrosoftAuthenticator, MinecraftProfile } from './network/microsoft_auth';
import { MinecraftProtocol263Client } from './network/protocol_26_3';
import { WorldgenDataJson, WorldgenNoiseRouter } from './world/noise_router';
import { AABB, BiomeRegistryEntry, BlockRegistryEntry, ClientWorld } from './world/physics_tick';
import { AtlasUVEntry, ChunkMesher } from './renderer/chunk_mesher';
import { DualRenderEngine } from './renderer/render_engine';
import { VanillaScreenManager } from './gui/vanilla_screens';

interface RegistriesBundle {
    version: string;
    protocol_version: number;
    data_version: number;
    atlases: {
        blocks: { width: number; height: number; uvs: Record<string, AtlasUVEntry> };
        items: { width: number; height: number; uvs: Record<string, AtlasUVEntry> };
    };
    blocks: BlockRegistryEntry[];
    items: Array<{ id: string; name: string; rawId: number; isBlock: boolean; texture: string }>;
    entities: Array<{ id: string; name: string; rawId: number; width: number; height: number }>;
    biomes: BiomeRegistryEntry[];
    particles: Array<{ id: string; name: string; rawId: number }>;
    soundEvents: Record<string, string[]>;
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

function parseWorldSeedBigInt(seedStr: string): bigint {
    const trimmed = seedStr.trim();
    if (!trimmed) {
        return BigInt(Math.floor(Math.random() * 0x7fffffff));
    }
    if (/^-?\d+$/.test(trimmed)) {
        try {
            return BigInt(trimmed);
        } catch {}
    }
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < trimmed.length; i++) {
        h ^= BigInt(trimmed.charCodeAt(i));
        h = BigInt.asUintN(64, h * 0x100000001b3n);
    }
    return BigInt.asIntN(64, h);
}

export class Minecraft263ClientApp {
    private registries!: RegistriesBundle;
    private worldgenData!: WorldgenDataJson;
    private defaultStructureTemplate: StructureTemplateData | null = null;
    private blocksImg!: HTMLImageElement;
    private itemsImg!: HTMLImageElement;
    private asciiImg!: HTMLImageElement;

    private world!: ClientWorld;
    private mesher!: ChunkMesher;
    private renderer!: DualRenderEngine;
    private audio = new OpenALAudioEngine();
    private vfs = new BrowserVFS();
    private workerPool = new ThreadedWorkerPool();
    private pal!: PlatformAbstractionLayer;
    private gui!: VanillaScreenManager;

    private wisp = WispEpoxyClient.getOrCreate('wss://anura.pro/');
    private msaAuth = new MicrosoftAuthenticator(this.wisp);
    private netClient: MinecraftProtocol263Client | null = null;
    private profile: MinecraftProfile = MicrosoftAuthenticator.createOfflineProfile('Player26_3');

    // Active Singleplayer World State
    private inWorld = false;
    private currentWorldSummary: SavedWorldSummary | null = null;
    private modifiedBlocksMap: Map<string, number> = new Map();

    // Player Physics State (20 TPS + partialTick interpolation)
    private px = 8.5;
    private py = 84.0;
    private pz = 8.5;
    private prevPx = 8.5;
    private prevPy = 84.0;
    private prevPz = 8.5;
    private vx = 0;
    private vy = 0;
    private vz = 0;
    private yawRad = 0;
    private pitchRad = 0;
    private onGround = false;
    private isFlying = false;
    private lastSpaceTapMs = 0;
    private swingProgress = 0;
    private isSwinging = false;
    private stepDistanceAccum = 0;

    // Input & HUD State
    private keysDown: Set<string> = new Set();
    private selectedHotbarSlot = 0;
    private hotbarBlocks: BlockRegistryEntry[] = [];
    private showF3Debug = false;
    private hideGuiF1 = false;
    private sneakLatched = false;
    private sprintLatched = false;

    // Player Statistics (`StatsScreen`)
    private playerStats: Record<string, number> = {
        blocks_mined: 0,
        blocks_placed: 0,
        jumps: 0,
        distance_walked_cm: 0,
        ticks_played: 0,
        mobs_hit: 0,
    };

    // Loop Telemetry
    private fps = 60;
    private frameCounter = 0;
    private lastFpsUpdateMs = performance.now();
    private lastFrameTimeMs = performance.now();
    private lastRenderedFrameMs = 0;
    private tickAccumulatorMs = 0;

    public async start(): Promise<void> {
        this.pal = new PlatformAbstractionLayer(this.vfs, this.audio);

        const guiRoot = document.getElementById('vanilla-gui-root') as HTMLElement;
        const bgCanvas = document.getElementById('gui-bg-canvas') as HTMLCanvasElement;
        this.gui = new VanillaScreenManager(
            this.pal,
            {
                onStartWorld: (cfg) => this.startSingleplayerWorld(cfg),
                onSaveAndQuitToTitle: () => this.saveAndQuitToTitle(),
                onVideoOptionsChanged: (backendSwitch) => this.applyOptionsToEngine(backendSwitch),
                onSelectHotbarBlock: (slot, block) => {
                    this.hotbarBlocks[slot] = block;
                },
                getHotbarBlocks: () => this.hotbarBlocks,
                getSelectedHotbarSlot: () => this.selectedHotbarSlot,
                getBlockUvs: () => this.registries?.atlases.blocks.uvs || {},
                getAllBlocks: () => this.registries?.blocks || [],
                getAllBiomes: () => this.registries?.biomes || [],
                getPlayerStats: () => this.playerStats,
                onPingMultiplayer: (wispUrl, serverAddr, setLog) => this.pingMultiplayer(wispUrl, serverAddr, setLog),
                onConnectMultiplayer: (wispUrl, serverAddr, username, setLog) =>
                    this.connectMultiplayer(wispUrl, serverAddr, username, setLog),
                onMsaLogin: (wispUrl, setLog, onName) => this.loginMicrosoft(wispUrl, setLog, onName),
            },
            guiRoot,
            bgCanvas
        );

        // Start animation loop immediately so `SplashOverlay` (`LoadingOverlay`) renders Mojang Red bar & logo
        requestAnimationFrame((t) => this.frameLoop(t));

        this.gui.setSplashProgress(10, 'Initializing JVM-to-WASM Core (mc26_3_core.wasm) & Epoxy Wisp...');
        await JvmWasmCore.init('assets/mc26_3_core.wasm');
        await this.wisp.initEpoxyWasm('assets/epoxy.wasm');
        await this.vfs.init();
        this.workerPool.initInlineWorkers();

        this.gui.setSplashProgress(26, 'Loading JVM Classfile v69.0 Bytecode (bytecode_gui.json) & I18n...');
        let enUsDict: Record<string, string> = {};
        try {
            const enResp = await fetch('assets/lang/en_us.json');
            if (enResp.ok) enUsDict = await enResp.json();
        } catch {}
        await this.pal.init('assets/bytecode_gui.json', enUsDict);
        await this.gui.loadGuiTextures();

        this.gui.setSplashProgress(48, 'Loading Minecraft 26.3 Registries (1,288 Blocks, 1,253 Items, 67 Biomes)...');
        const [regResp, wgResp] = await Promise.all([
            fetch('assets/registries.json'),
            fetch('assets/worldgen.json'),
        ]);
        this.registries = await regResp.json();
        this.worldgenData = await wgResp.json();
        this.audio.setSoundEventsRegistry(this.registries.soundEvents);

        this.gui.setSplashProgress(70, 'Loading Stitched Texture Atlases (blocks.png, items.png, ascii.png)...');
        const [blocksImg, itemsImg, asciiImg] = await Promise.all([
            loadImage('assets/blocks.png'),
            loadImage('assets/items.png'),
            loadImage('assets/ascii.png'),
        ]);
        this.blocksImg = blocksImg;
        this.itemsImg = itemsImg;
        this.asciiImg = asciiImg;

        this.gui.setSplashProgress(86, 'Initializing Dual WebGPU / WebGL2 Rendering Pipeline...');
        const canvas3D = document.getElementById('game-canvas-3d') as HTMLCanvasElement;
        const canvasGui = document.getElementById('game-canvas-gui') as HTMLCanvasElement;
        this.renderer = new DualRenderEngine(canvas3D, canvasGui);
        this.renderer.resize(window.innerWidth, window.innerHeight);
        await this.renderer.init(
            blocksImg,
            itemsImg,
            asciiImg,
            this.pal.options.preferredGraphicsBackend
        );

        // Preload sample .nbt structure template (Minecraft 26.3 Dappled Forest Abandoned Camp)
        try {
            const nbtResp = await fetch('assets/structures/abandoned_camp__camp__dappled_forest__campsite_dappled_forest_1.nbt');
            if (nbtResp.ok) {
                const nbtBytes = new Uint8Array(await nbtResp.arrayBuffer());
                this.defaultStructureTemplate = await parseStructureTemplateNbt(nbtBytes);
            }
        } catch {}

        // Construct initial idle ClientWorld for background / hotbar reference before user selects a world
        const initialRouter = new WorldgenNoiseRouter(2632026n, this.worldgenData);
        this.world = new ClientWorld(this.registries.blocks, this.registries.biomes, initialRouter);
        this.mesher = new ChunkMesher(this.world, this.registries.atlases.blocks.uvs);

        const pickBlock = (name: string) =>
            this.world.blockByName.get(name) || this.registries.blocks[1];
        this.hotbarBlocks = [
            pickBlock('sulfur'),
            pickBlock('potent_sulfur'),
            pickBlock('sulfur_bricks'),
            pickBlock('pale_oak_log'),
            pickBlock('cherry_leaves'),
            pickBlock('grass_block'),
            pickBlock('cobblestone'),
            pickBlock('water'),
            pickBlock('glowstone'),
        ];

        await this.applyOptionsToEngine(false);
        this.bindGlobalControls();

        // Complete `SplashOverlay` -> fades out into `TitleScreen` (never skips TitleScreen!)
        this.gui.openScreen('title', false);
        this.gui.setSplashProgress(100, 'Ready — Transitioning to TitleScreen...');
    }

    private async applyOptionsToEngine(backendSwitchRequested?: boolean): Promise<void> {
        const opts = this.pal.options;
        this.pal.syncAudioOptions();

        if (!this.renderer || !this.mesher) return;

        if (backendSwitchRequested && this.renderer.backend !== opts.preferredGraphicsBackend) {
            const oldCanvas = document.getElementById('game-canvas-3d')!;
            const newCanvas = document.createElement('canvas');
            newCanvas.id = 'game-canvas-3d';
            newCanvas.width = window.innerWidth;
            newCanvas.height = window.innerHeight;
            oldCanvas.parentNode?.replaceChild(newCanvas, oldCanvas);

            const guiCanvas = document.getElementById('game-canvas-gui') as HTMLCanvasElement;
            this.renderer = new DualRenderEngine(newCanvas, guiCanvas);
            await this.renderer.init(this.blocksImg, this.itemsImg, this.asciiImg, opts.preferredGraphicsBackend);
        }

        const prevSmooth = this.mesher.smoothLighting;
        this.mesher.smoothLighting = opts.smoothLighting;
        this.renderer.gamma = opts.gamma;
        this.renderer.cloudMode = opts.renderClouds;
        this.renderer.cloudHeight = opts.cloudRange;
        this.renderer.particlesMode = opts.particles;
        this.renderer.entityShadows = opts.entityShadows;
        this.renderer.entityDistanceScaling = opts.entityDistanceScaling;
        this.renderer.guiScale = opts.guiScale;
        this.renderer.mainHand = opts.mainHand;
        this.renderer.attackIndicator = opts.attackIndicator;
        this.renderer.activeSubtitles = this.audio.activeSubtitles;

        if (this.inWorld && (prevSmooth !== opts.smoothLighting || backendSwitchRequested)) {
            this.renderer.clearChunkMeshes();
            for (const col of this.world.chunks.values()) {
                this.renderer.uploadChunkMesh(this.mesher.buildChunkMesh(col));
            }
        }
    }

    /**
     * Launches a Singleplayer World (`SelectWorldScreen` -> Play or `CreateWorldScreen` -> Create New World).
     */
    private async startSingleplayerWorld(worldConfig: SavedWorldSummary): Promise<void> {
        this.currentWorldSummary = worldConfig;
        this.currentWorldSummary.lastPlayedMs = Date.now();
        await this.pal.persistSavedWorlds();

        const seedBig = parseWorldSeedBigInt(worldConfig.seed);
        const router = new WorldgenNoiseRouter(seedBig, this.worldgenData);
        this.world = new ClientWorld(this.registries.blocks, this.registries.biomes, router, {
            worldType: worldConfig.worldType,
            flatLayers: worldConfig.flatLayers,
            flatBiome: worldConfig.flatBiome,
            singleBiome: worldConfig.singleBiome,
            generateStructures: worldConfig.generateStructures,
            bonusChest: worldConfig.bonusChest,
            gameRules: worldConfig.gameRules,
        });

        if (this.defaultStructureTemplate && worldConfig.generateStructures) {
            this.world.structures.set('abandoned_camp/campsite_dappled_forest_1', this.defaultStructureTemplate);
        }

        this.mesher = new ChunkMesher(this.world, this.registries.atlases.blocks.uvs);
        this.mesher.smoothLighting = this.pal.options.smoothLighting;
        this.renderer.clearChunkMeshes();

        // Generate initial 5x5 chunk grid around (0, 0)
        for (let cx = -2; cx <= 2; cx++) {
            for (let cz = -2; cz <= 2; cz++) {
                this.world.getOrCreateChunk(cx, cz);
            }
        }

        // Apply saved block diffs if reopening an existing world
        this.modifiedBlocksMap.clear();
        if (worldConfig.blockDiffs) {
            for (const [bx, by, bz, blockId] of worldConfig.blockDiffs) {
                this.world.setBlockId(bx, by, bz, blockId, false);
                this.modifiedBlocksMap.set(`${bx},${by},${bz}`, blockId);
            }
        }

        const spawnChunk = this.world.getOrCreateChunk(0, 0);
        const spawnSurfY = spawnChunk.heightmap[(8 << 4) | 8];

        // Bonus chest placement on first load if requested
        if (worldConfig.bonusChest && !worldConfig.playerState) {
            const chestBlock = this.world.blockByName.get('chest');
            const torchBlock = this.world.blockByName.get('torch');
            if (chestBlock) {
                this.world.setBlockId(8, spawnSurfY + 1, 6, chestBlock.rawId, false);
                if (torchBlock) {
                    this.world.setBlockId(7, spawnSurfY + 1, 6, torchBlock.rawId, false);
                    this.world.setBlockId(9, spawnSurfY + 1, 6, torchBlock.rawId, false);
                }
            }
        }

        // Upload chunk meshes to GPU
        for (const col of this.world.chunks.values()) {
            const mesh = this.mesher.buildChunkMesh(col);
            this.renderer.uploadChunkMesh(mesh);
        }

        if (worldConfig.playerState) {
            this.px = worldConfig.playerState.x;
            this.py = worldConfig.playerState.y;
            this.pz = worldConfig.playerState.z;
            this.yawRad = worldConfig.playerState.yawRad;
            this.pitchRad = worldConfig.playerState.pitchRad;
        } else {
            this.px = 8.5;
            this.py = spawnSurfY + 2.0;
            this.pz = 8.5;
            this.yawRad = 0;
            this.pitchRad = 0;
        }
        this.prevPx = this.px;
        this.prevPy = this.py;
        this.prevPz = this.pz;
        this.vx = 0;
        this.vy = 0;
        this.vz = 0;
        this.isFlying = false;

        // Spawn ambient mobs if do_mob_spawning is enabled
        if (this.world.gameRules.do_mob_spawning !== false && worldConfig.worldType !== 'debug_all_block_states') {
            this.world.spawnMob('sulfur_cube', this.px + 2.5, spawnSurfY + 2.0, this.pz - 4.5);
            this.world.spawnMob('pig', this.px - 3.5, spawnSurfY + 2.0, this.pz - 5.0);
        }

        this.inWorld = true;
        this.gui.inWorld = true;
        this.audio.stopMenuMusic();

        const canvasGui = document.getElementById('game-canvas-gui') as HTMLCanvasElement;
        try {
            canvasGui.requestPointerLock();
        } catch {}
    }

    /**
     * Saves the active Singleplayer world state (`playerState` & `blockDiffs`) to OPFS/IndexedDB
     * and returns cleanly to `TitleScreen`.
     */
    private async saveAndQuitToTitle(): Promise<void> {
        if (this.currentWorldSummary) {
            const diffs: Array<[number, number, number, number]> = [];
            for (const [k, v] of this.modifiedBlocksMap.entries()) {
                const [bx, by, bz] = k.split(',').map(Number);
                diffs.push([bx, by, bz, v]);
            }
            this.currentWorldSummary.playerState = {
                x: this.px,
                y: this.py,
                z: this.pz,
                yawRad: this.yawRad,
                pitchRad: this.pitchRad,
            };
            this.currentWorldSummary.blockDiffs = diffs;
            this.currentWorldSummary.lastPlayedMs = Date.now();
            await this.pal.persistSavedWorlds();
        }

        this.netClient?.disconnect();
        this.netClient = null;
        this.inWorld = false;
        this.gui.inWorld = false;
        this.renderer.clearChunkMeshes();
        if (document.pointerLockElement) {
            document.exitPointerLock();
        }
    }

    private isKeyBoundPressed(actionKey: string): boolean {
        const boundCode = this.pal.options.getKeyCode(actionKey);
        return boundCode ? this.keysDown.has(boundCode) : false;
    }

    private bindGlobalControls(): void {
        const canvasGui = document.getElementById('game-canvas-gui') as HTMLCanvasElement;

        window.addEventListener('resize', () => {
            this.renderer.resize(window.innerWidth, window.innerHeight);
        });

        canvasGui.addEventListener('mousedown', (e) => {
            if (!this.inWorld || this.gui.activeScreen !== 'none') return;
            this.audio.ensureContext();
            if (document.pointerLockElement !== canvasGui) {
                canvasGui.requestPointerLock();
                return;
            }
            const mouseCode = `Mouse${e.button}`;
            if (mouseCode === this.pal.options.getKeyCode('key.attack') || e.button === 0) {
                this.handleMouseAction(0);
            } else if (mouseCode === this.pal.options.getKeyCode('key.use') || e.button === 2) {
                this.handleMouseAction(2);
            } else if (mouseCode === this.pal.options.getKeyCode('key.pickItem') || e.button === 1) {
                this.handleMouseAction(1);
            }
        });

        window.addEventListener('contextmenu', (e) => e.preventDefault());

        document.addEventListener('mousemove', (e) => {
            if (!this.inWorld || this.gui.activeScreen !== 'none') return;
            if (document.pointerLockElement !== canvasGui) return;
            const sensOption = this.pal.options.mouseSensitivity;
            const f = sensOption * 0.6 + 0.2;
            const sens = f * f * f * 0.008;
            const invertMult = this.pal.options.invertYMouse ? -1 : 1;
            this.yawRad -= e.movementX * sens;
            this.pitchRad = Math.max(
                -Math.PI * 0.495,
                Math.min(Math.PI * 0.495, this.pitchRad - e.movementY * sens * invertMult)
            );
        });

        window.addEventListener('wheel', (e) => {
            if (!this.inWorld || this.gui.activeScreen !== 'none') return;
            if (e.deltaY > 0) this.selectedHotbarSlot = (this.selectedHotbarSlot + 1) % 9;
            else if (e.deltaY < 0) this.selectedHotbarSlot = (this.selectedHotbarSlot + 8) % 9;
        });

        window.addEventListener('keydown', (e) => {
            if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT') {
                return;
            }

            const getKey = (id: string) => this.pal.options.getKeyCode(id);

            if (e.code === getKey('key.fullscreen') || e.code === 'F11') {
                e.preventDefault();
                this.pal.options.fullscreen = !this.pal.options.fullscreen;
                if (this.pal.options.fullscreen) document.documentElement.requestFullscreen?.().catch(() => {});
                else document.exitFullscreen?.().catch(() => {});
                this.pal.saveOptions();
                return;
            }

            if (!this.inWorld) return;

            if (e.code === getKey('key.toggleGui') || e.code === 'F1') {
                e.preventDefault();
                this.hideGuiF1 = !this.hideGuiF1;
                return;
            }

            if (e.code === getKey('key.debug.overlay') || e.code === 'F3') {
                e.preventDefault();
                this.showF3Debug = !this.showF3Debug;
                return;
            }

            if (e.code === getKey('key.inventory')) {
                e.preventDefault();
                if (this.gui.activeScreen === 'creative_inventory') {
                    this.gui.openScreen('none', false);
                    canvasGui.requestPointerLock();
                } else if (this.gui.activeScreen === 'none') {
                    this.gui.openScreen('creative_inventory', true);
                }
                return;
            }

            if (e.code === getKey('key.advancements')) {
                e.preventDefault();
                if (this.gui.activeScreen === 'advancements') {
                    this.gui.openScreen('none', false);
                    canvasGui.requestPointerLock();
                } else if (this.gui.activeScreen === 'none') {
                    this.gui.openScreen('advancements', true);
                }
                return;
            }

            // Hotbar 1..9
            for (let i = 1; i <= 9; i++) {
                if (e.code === getKey(`key.hotbar.${i}`)) {
                    this.selectedHotbarSlot = i - 1;
                }
            }

            // Toggle vs Hold Sneak / Sprint
            if (e.code === getKey('key.sneak') && !this.keysDown.has(e.code) && this.pal.options.toggleCrouch) {
                this.sneakLatched = !this.sneakLatched;
            }
            if (e.code === getKey('key.sprint') && !this.keysDown.has(e.code) && this.pal.options.toggleSprint) {
                this.sprintLatched = !this.sprintLatched;
            }

            // Double-tap Jump for Creative/Commands flight
            if (e.code === getKey('key.jump') && !this.keysDown.has(e.code)) {
                const now = performance.now();
                const canFly =
                    !this.currentWorldSummary ||
                    this.currentWorldSummary.gameMode === 'creative' ||
                    this.currentWorldSummary.allowCommands;
                if (canFly && now - this.lastSpaceTapMs < 280) {
                    this.isFlying = !this.isFlying;
                    this.vy = 0;
                }
                this.lastSpaceTapMs = now;
            }

            this.keysDown.add(e.code);
        });

        window.addEventListener('keyup', (e) => {
            this.keysDown.delete(e.code);
        });
    }

    private async pingMultiplayer(wispUrl: string, serverAddr: string, setLog: (msg: string) => void): Promise<void> {
        try {
            if (wispUrl) this.wisp.setWispServer(wispUrl);
            setLog(`Pinging ${serverAddr} via Wisp (${this.wisp.wispUrl})...`);
            const client = new MinecraftProtocol263Client(this.wisp);
            const status = await client.pingServerStatus(serverAddr);
            const motd =
                typeof status.description === 'string'
                    ? status.description
                    : status.description.text || JSON.stringify(status.description);
            setLog(
                `Online! Version: ${status.version.name} (Protocol ${status.version.protocol}) | Players: ${status.players.online}/${status.players.max} | RTT: ${status.latencyMs}ms | MOTD: ${motd}`
            );
        } catch (err) {
            setLog(`Ping error: ${(err as Error).message}`);
        }
    }

    private async connectMultiplayer(
        wispUrl: string,
        serverAddr: string,
        username: string,
        setLog: (msg: string) => void
    ): Promise<void> {
        try {
            if (wispUrl) this.wisp.setWispServer(wispUrl);
            if (username && this.profile.offlineMode) {
                this.profile = MicrosoftAuthenticator.createOfflineProfile(username);
            }
            this.netClient?.disconnect();
            this.netClient = new MinecraftProtocol263Client(this.wisp, {
                onStatusUpdate: setLog,
                onLoginSuccess: (uuid, name) => setLog(`LoginSuccess: ${name} (${uuid})`),
                onEnterPlayState: async () => {
                    setLog(`Connected to ${serverAddr} in Play State (Protocol 777)!`);
                    if (!this.inWorld && this.pal.savedWorlds.length > 0) {
                        await this.startSingleplayerWorld(this.pal.savedWorlds[0]);
                    }
                    this.gui.openScreen('none', false);
                },
                onDisconnect: (reason) => setLog(`Disconnected: ${reason}`),
                onPlayerPosition: (x, y, z, yaw, pitch) => {
                    this.px = x;
                    this.py = y;
                    this.pz = z;
                    this.yawRad = (-yaw * Math.PI) / 180;
                    this.pitchRad = (-pitch * Math.PI) / 180;
                },
                onBlockUpdate: (x, y, z, stateId) => {
                    this.world.setBlockId(x, y, z, stateId % this.registries.blocks.length);
                },
            });
            await this.netClient.connectToServer(serverAddr, this.profile);
        } catch (err) {
            setLog(`Connect error: ${(err as Error).message}`);
        }
    }

    private async loginMicrosoft(
        wispUrl: string,
        setLog: (msg: string) => void,
        onName: (name: string) => void
    ): Promise<void> {
        try {
            if (wispUrl) this.wisp.setWispServer(wispUrl);
            setLog('Requesting Microsoft OAuth 2.0 Device Code...');
            const dc = await this.msaAuth.requestDeviceCode();
            setLog(`${dc.message} (Polling for authorization...)`);
            const tokens = await this.msaAuth.pollDeviceCodeToken(dc.deviceCode, dc.interval, setLog);
            setLog('Exchanging Microsoft Token -> Xbox Live -> XSTS -> Minecraft Services...');
            this.profile = await this.msaAuth.authenticateMinecraftWithMsaToken(tokens.accessToken, tokens.refreshToken);
            onName(this.profile.name);
            setLog(`Authenticated as ${this.profile.name} (UUID: ${this.profile.id})`);
        } catch (err) {
            setLog(`Microsoft OAuth Notice: ${(err as Error).message}`);
        }
    }

    private getCameraForward(): [number, number, number] {
        const fx = -Math.sin(this.yawRad) * Math.cos(this.pitchRad);
        const fy = Math.sin(this.pitchRad);
        const fz = -Math.cos(this.yawRad) * Math.cos(this.pitchRad);
        return [fx, fy, fz];
    }

    private handleMouseAction(button: number): void {
        const [fx, fy, fz] = this.getCameraForward();
        const eyeY = this.py + 1.62;
        const hit = this.world.raycastBlock(this.px, eyeY, this.pz, fx, fy, fz, 5.5);

        if (button === 0) {
            this.isSwinging = true;
            this.swingProgress = 0;

            for (const ent of this.world.entities.values()) {
                const dx = ent.x - this.px;
                const dy = ent.y + ent.height * 0.5 - eyeY;
                const dz = ent.z - this.pz;
                const dist = Math.hypot(dx, dy, dz);
                if (dist < 4.0) {
                    const dot = (dx * fx + dy * fy + dz * fz) / (dist || 1);
                    if (dot > 0.85) {
                        ent.hurtTime = 10;
                        ent.vy = 0.36;
                        ent.vx += fx * 0.4;
                        ent.vz += fz * 0.4;
                        this.playerStats.mobs_hit = (this.playerStats.mobs_hit || 0) + 1;
                        this.audio.playSoundEvent(
                            'entity.player.attack.strong',
                            SoundSource.PLAYERS,
                            ent.x,
                            ent.y,
                            ent.z,
                            1.0,
                            1.0,
                            true
                        );
                        return;
                    }
                }
            }

            if (hit) {
                const uv = this.mesher.getUV(hit.block.textures.north);
                this.renderer.spawnBlockBreakParticles(hit.x, hit.y, hit.z, uv);
                this.world.setBlockId(hit.x, hit.y, hit.z, this.world.idAir, true);
                this.modifiedBlocksMap.set(`${hit.x},${hit.y},${hit.z}`, this.world.idAir);
                this.playerStats.blocks_mined = (this.playerStats.blocks_mined || 0) + 1;
                this.audio.playSoundEvent(
                    'block.stone.break',
                    SoundSource.BLOCKS,
                    hit.x + 0.5,
                    hit.y + 0.5,
                    hit.z + 0.5,
                    0.9,
                    0.95,
                    true
                );
            }
        } else if (button === 2 && hit) {
            const tx = hit.x + hit.nx;
            const ty = hit.y + hit.ny;
            const tz = hit.z + hit.nz;
            const selected = this.hotbarBlocks[this.selectedHotbarSlot];
            if (!selected) return;

            const playerBox: AABB = {
                minX: this.px - 0.3,
                minY: this.py,
                minZ: this.pz - 0.3,
                maxX: this.px + 0.3,
                maxY: this.py + 1.8,
                maxZ: this.pz + 0.3,
            };
            if (
                !selected.properties.noCollision &&
                !selected.properties.liquid &&
                playerBox.maxX > tx &&
                playerBox.minX < tx + 1 &&
                playerBox.maxY > ty &&
                playerBox.minY < ty + 1 &&
                playerBox.maxZ > tz &&
                playerBox.minZ < tz + 1
            ) {
                return;
            }

            this.isSwinging = true;
            this.swingProgress = 0;
            this.world.setBlockId(tx, ty, tz, selected.rawId, true);
            this.modifiedBlocksMap.set(`${tx},${ty},${tz}`, selected.rawId);
            this.playerStats.blocks_placed = (this.playerStats.blocks_placed || 0) + 1;
            this.audio.playSoundEvent(
                'block.stone.place',
                SoundSource.BLOCKS,
                tx + 0.5,
                ty + 0.5,
                tz + 0.5,
                0.9,
                1.05,
                true
            );
        } else if (button === 1 && hit) {
            this.hotbarBlocks[this.selectedHotbarSlot] = hit.block;
        }
    }

    /**
     * Executes one fixed 20 TPS (50ms) client tick when a world is active and not paused.
     */
    private clientTick(): void {
        if (!this.inWorld || this.gui.activeScreen === 'pause') return;

        this.prevPx = this.px;
        this.prevPy = this.py;
        this.prevPz = this.pz;
        this.playerStats.ticks_played = (this.playerStats.ticks_played || 0) + 1;

        if (this.isSwinging) {
            this.swingProgress += 0.22;
            if (this.swingProgress >= 1.0) {
                this.swingProgress = 0;
                this.isSwinging = false;
            }
        }

        let forwardInput = 0;
        let strafeInput = 0;
        if (this.gui.activeScreen === 'none') {
            if (this.isKeyBoundPressed('key.forward')) forwardInput += 1;
            if (this.isKeyBoundPressed('key.back')) forwardInput -= 1;
            if (this.isKeyBoundPressed('key.right')) strafeInput += 1;
            if (this.isKeyBoundPressed('key.left')) strafeInput -= 1;
        }

        const len = Math.hypot(forwardInput, strafeInput);
        if (len > 0) {
            forwardInput /= len;
            strafeInput /= len;
        }

        const sinY = Math.sin(this.yawRad);
        const cosY = Math.cos(this.yawRad);
        const wishX = -sinY * forwardInput + cosY * strafeInput;
        const wishZ = -cosY * forwardInput - sinY * strafeInput;

        const isSprinting = this.pal.options.toggleSprint
            ? this.sprintLatched
            : this.isKeyBoundPressed('key.sprint');
        const isSneaking = this.pal.options.toggleCrouch
            ? this.sneakLatched
            : this.isKeyBoundPressed('key.sneak');
        const isJumping = this.gui.activeScreen === 'none' && this.isKeyBoundPressed('key.jump');

        const feetBlock = this.world.getBlockId(Math.floor(this.px), Math.floor(this.py), Math.floor(this.pz));
        const inWater = feetBlock === this.world.idWater;

        if (this.isFlying) {
            const flySpeed = isSprinting ? 0.55 : 0.30;
            this.vx = this.vx * 0.6 + wishX * flySpeed * 0.4;
            this.vz = this.vz * 0.6 + wishZ * flySpeed * 0.4;
            this.vy = 0;
            if (isJumping) this.vy = 0.35;
            if (isSneaking) this.vy = -0.35;
        } else if (inWater) {
            const swimSpeed = 0.14;
            this.vx = this.vx * 0.8 + wishX * swimSpeed * 0.2;
            this.vz = this.vz * 0.8 + wishZ * swimSpeed * 0.2;
            this.vy = (this.vy - 0.02) * 0.85;
            if (isJumping) this.vy += 0.06;
        } else {
            const baseAccel = isSneaking ? 0.06 : isSprinting ? 0.165 : 0.12;
            const friction = this.onGround ? 0.546 : 0.91;
            this.vx = this.vx * friction + wishX * baseAccel;
            this.vz = this.vz * friction + wishZ * baseAccel;

            if (isJumping && this.onGround) {
                this.vy = 0.42;
                this.onGround = false;
                this.playerStats.jumps = (this.playerStats.jumps || 0) + 1;
            }
            this.vy = (this.vy - 0.08) * 0.98;
        }

        const playerBox: AABB = {
            minX: this.px - 0.3,
            minY: this.py,
            minZ: this.pz - 0.3,
            maxX: this.px + 0.3,
            maxY: this.py + 1.8,
            maxZ: this.pz + 0.3,
        };
        const moved = this.world.moveEntityWithCollisions(playerBox, this.vx, this.vy, this.vz);
        const nextPx = (moved.box.minX + moved.box.maxX) * 0.5;
        const nextPy = moved.box.minY;
        const nextPz = (moved.box.minZ + moved.box.maxZ) * 0.5;

        // Auto-Jump support (`options.autoJump`)
        const horizBlocked =
            Math.hypot(nextPx - this.px, nextPz - this.pz) < Math.hypot(this.vx, this.vz) * 0.5 &&
            Math.hypot(wishX, wishZ) > 0.1;
        if (this.pal.options.autoJump && this.onGround && horizBlocked && !isSneaking) {
            this.vy = 0.42;
            this.onGround = false;
            this.playerStats.jumps = (this.playerStats.jumps || 0) + 1;
        } else {
            this.px = nextPx;
            this.py = nextPy;
            this.pz = nextPz;
            this.onGround = moved.onGround;
        }

        if (moved.onGround && this.vy < 0) {
            this.vy = 0;
            this.isFlying = false;
        }

        const stepDist = Math.hypot(this.px - this.prevPx, this.pz - this.prevPz);
        this.playerStats.distance_walked_cm = (this.playerStats.distance_walked_cm || 0) + Math.round(stepDist * 100);
        if (this.onGround) {
            this.stepDistanceAccum += stepDist;
            if (this.stepDistanceAccum > 1.85) {
                this.stepDistanceAccum = 0;
                this.audio.playSoundEvent('block.grass.step', SoundSource.PLAYERS, this.px, this.py, this.pz, 0.35, 1.0, false);
            }
        }

        this.world.tick(this.px, this.py, this.pz);
        this.renderer.stepParticles();
        this.workerPool.recordTickCompleted(Number(this.world.worldAgeTicks));

        this.netClient
            ?.sendPlayerPositionAndRotation(
                this.px,
                this.py,
                this.pz,
                (-this.yawRad * 180) / Math.PI,
                (-this.pitchRad * 180) / Math.PI,
                this.onGround
            )
            .catch(() => {});

        // Stream & mesh nearby dirty chunks around the player according to `renderDistance`
        const renderDist = Math.min(8, Math.max(2, this.pal.options.renderDistance));
        const pcx = Math.floor(this.px) >> 4;
        const pcz = Math.floor(this.pz) >> 4;
        let meshedThisTick = 0;
        for (let r = 0; r <= renderDist && meshedThisTick < 1; r++) {
            for (let dx = -r; dx <= r && meshedThisTick < 1; dx++) {
                for (let dz = -r; dz <= r && meshedThisTick < 1; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                    const cx = pcx + dx;
                    const cz = pcz + dz;
                    const key = ChunkPos.asLong(cx, cz);
                    const existing = this.world.chunks.get(key);
                    if (!existing || existing.dirty) {
                        const col = this.world.getOrCreateChunk(cx, cz);
                        const mesh = this.mesher.buildChunkMesh(col);
                        this.renderer.uploadChunkMesh(mesh);
                        meshedThisTick++;
                    }
                }
            }
        }
    }

    private frameLoop(nowMs: number): void {
        requestAnimationFrame((t) => this.frameLoop(t));

        // Max Framerate limiter (`options.maxFps` when < 260)
        const maxFps = this.pal?.options.maxFps ?? 120;
        if (maxFps < 260 && this.inWorld) {
            const minFrameInterval = 1000 / Math.max(10, maxFps);
            if (nowMs - this.lastRenderedFrameMs < minFrameInterval - 0.5) {
                return;
            }
        }
        this.lastRenderedFrameMs = nowMs;

        const dtMs = Math.min(250, Math.max(0, nowMs - this.lastFrameTimeMs));
        this.lastFrameTimeMs = nowMs;

        // Render GUI background canvas (`SplashOverlay`, `TitleScreen` Panorama, and sinusoidal splash text bounce)
        this.gui?.renderFrame(nowMs);

        if (!this.inWorld || !this.renderer || !this.world) {
            return;
        }

        this.tickAccumulatorMs += dtMs;
        while (this.tickAccumulatorMs >= 50.0) {
            this.clientTick();
            this.tickAccumulatorMs -= 50.0;
        }

        const partialTick = this.gui.activeScreen === 'pause' ? 0 : this.tickAccumulatorMs / 50.0;
        const isSneaking = this.pal.options.toggleCrouch
            ? this.sneakLatched
            : this.isKeyBoundPressed('key.sneak');
        const eyeHeight = isSneaking ? 1.27 : 1.62;

        // View Bobbing offset (`options.bobView`)
        let bobY = 0;
        if (this.pal.options.bobView && this.onGround && !this.isFlying) {
            const speed = Math.hypot(this.px - this.prevPx, this.pz - this.prevPz);
            bobY = Math.sin(this.stepDistanceAccum * Math.PI * 2.0) * Math.min(0.08, speed * 0.35);
        }

        const renderX = this.prevPx + (this.px - this.prevPx) * partialTick;
        const renderY = this.prevPy + (this.py - this.prevPy) * partialTick + eyeHeight + bobY;
        const renderZ = this.prevPz + (this.pz - this.prevPz) * partialTick;

        this.audio.updateListener(
            renderX,
            renderY,
            renderZ,
            this.yawRad,
            this.pitchRad,
            this.vx * 20,
            this.vy * 20,
            this.vz * 20
        );

        const [fx, fy, fz] = this.getCameraForward();
        const hit = this.world.raycastBlock(renderX, renderY, renderZ, fx, fy, fz, 5.5);

        const baseFov = this.pal.options.fov || 70;
        const isSprinting = this.pal.options.toggleSprint
            ? this.sprintLatched
            : this.isKeyBoundPressed('key.sprint');
        const dynamicFov = baseFov + (isSprinting ? 10 * this.pal.options.fovEffectScale : 0);
        const renderDist = Math.min(8, Math.max(2, this.pal.options.renderDistance));

        this.renderer.renderWorldFrame(
            this.world,
            this.mesher,
            renderX,
            renderY,
            renderZ,
            this.yawRad,
            this.pitchRad,
            dynamicFov,
            renderDist,
            partialTick,
            hit
        );

        this.frameCounter++;
        if (nowMs - this.lastFpsUpdateMs >= 500) {
            this.fps = Math.round((this.frameCounter * 1000) / (nowMs - this.lastFpsUpdateMs));
            this.frameCounter = 0;
            this.lastFpsUpdateMs = nowMs;
        }

        if (this.hideGuiF1) {
            const guiCanvas = document.getElementById('game-canvas-gui') as HTMLCanvasElement;
            guiCanvas.getContext('2d')?.clearRect(0, 0, guiCanvas.width, guiCanvas.height);
            return;
        }

        const nr = this.world.noiseRouter.sampleOverworldRouter(
            Math.floor(this.px),
            Math.floor(this.py),
            Math.floor(this.pz)
        );
        const noiseSampleText =
            `C: ${nr.continents.toFixed(3)} E: ${nr.erosion.toFixed(3)} T: ${nr.temperature.toFixed(3)} ` +
            `V: ${nr.vegetation.toFixed(3)} W: ${nr.weirdness.toFixed(3)} PV: ${nr.ridges.toFixed(3)} D: ${nr.depth.toFixed(3)}`;

        this.renderer.activeSubtitles = this.audio.activeSubtitles;
        this.renderer.render2DGuiPass({
            fps: this.fps,
            playerX: renderX,
            playerY: renderY - eyeHeight,
            playerZ: renderZ,
            yawDeg: ((-this.yawRad * 180) / Math.PI) % 360,
            pitchDeg: (this.pitchRad * 180) / Math.PI,
            biomeName:
                this.world.worldType === 'flat'
                    ? this.world.flatBiome
                    : this.world.worldType === 'single_biome_surface'
                    ? this.world.singleBiome
                    : nr.biomeName,
            noiseSampleText,
            selectedHotbarSlot: this.selectedHotbarSlot,
            hotbarBlocks: this.hotbarBlocks,
            blockUvs: this.registries.atlases.blocks.uvs,
            showF3Debug: this.showF3Debug,
            swingProgress: this.swingProgress,
            health: 20,
            hunger: 20,
            xpLevel: 26,
            workerStatus: this.workerPool.getStatusSummary(),
            wispUrl: this.wisp.wispUrl,
            profileName: this.profile.name,
        });
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const app = new Minecraft263ClientApp();
    app.start().catch((err) => {
        console.error('[Bootstrap] Fatal startup error:', err);
    });
});
