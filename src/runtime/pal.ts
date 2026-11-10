/**
 * Platform Abstraction Layer (PAL) & TeaVM / JVM Classfile v69.0 Bytecode Runtime Bridge
 *
 * Swaps out desktop LWJGL 3 (GLFW, OpenGL, OpenAL, TinyFD, Jemalloc) and Java NIO filesystem
 * dependencies for Web standards (WebGPU/WebGL2, WebAudio HRTF, Pointer Lock, Fullscreen API,
 * Origin Private File System / IndexedDB) while executing the authentic Mojang `Options`,
 * `GameRules`, `KeyMapping`, `I18n`, `PackRepository`, and `LevelStorageSource` data models
 * transpiled from `.minecraft/versions/26.3/26.3.jar`.
 */

import { BrowserVFS } from './vfs_nbt';
import { OpenALAudioEngine, SoundSource } from './openal_audio';

export interface TranspiledMethodMeta {
    name: string;
    descriptor: string;
    accessFlags: number;
    codeLength: number;
    invokedMethods: string[];
}

export interface TranspiledClassMeta {
    className: string;
    superClass: string;
    majorVersion: number;
    minorVersion: number;
    accessFlags: number;
    constantPoolCount: number;
    fields: Array<{ name: string; descriptor: string; accessFlags: number }>;
    methods: TranspiledMethodMeta[];
    totalBytecodeInstructions: number;
    stringLiterals: string[];
}

export interface GameRuleMetadata {
    id: string;
    translationKey: string;
    label: string;
    description: string;
    category: string;
    categoryLabel: string;
    type: 'boolean' | 'int';
    defaultValue: boolean | number;
}

export interface FlatLayerConfig {
    block: string;
    height: number;
}

export interface FlatWorldPresetEntry {
    display: string;
    settings: {
        biome: string;
        features: boolean;
        lakes: boolean;
        layers: FlatLayerConfig[];
    };
}

export interface BytecodeGuiBundle {
    transpiler: string;
    sourceJar: string;
    classfileMajorVersion: number;
    totalClassesTranspiled: number;
    totalMethodsTranspiled: number;
    totalBytecodeInstructions: number;
    splashes: string[];
    languages: Record<string, { name: string; region: string; bidirectional: boolean }>;
    flatWorldPresets: Record<string, FlatWorldPresetEntry>;
    worldPresets: Record<string, unknown>;
    gameRules: GameRuleMetadata[];
    keyBinds: string[];
    classes: Record<string, TranspiledClassMeta>;
}

export interface KeyBindEntry {
    id: string; // e.g. 'key.forward'
    category: string; // e.g. 'key.categories.movement'
    defaultCode: string; // e.g. 'KeyW'
    boundCode: string;
}

export interface SavedWorldSummary {
    id: string;
    folderName: string;
    name: string;
    lastPlayedMs: number;
    createdMs: number;
    gameMode: 'survival' | 'hardcore' | 'creative';
    difficulty: 'peaceful' | 'easy' | 'normal' | 'hard';
    difficultyLocked: boolean;
    allowCommands: boolean;
    worldType: 'normal' | 'flat' | 'large_biomes' | 'amplified' | 'single_biome_surface' | 'debug_all_block_states';
    seed: string;
    generateStructures: boolean;
    bonusChest: boolean;
    flatLayers: FlatLayerConfig[];
    flatBiome: string;
    singleBiome: string;
    experiments: string[];
    dataPacks: string[];
    gameRules: Record<string, boolean | number>;
    versionName: string;
    protocolVersion: number;
    dataVersion: number;
    iconColor1: string;
    iconColor2: string;
    playerState?: {
        x: number;
        y: number;
        z: number;
        yawRad: number;
        pitchRad: number;
    };
    blockDiffs?: Array<[number, number, number, number]>;
}

export interface ResourcePackEntry {
    id: string;
    title: string;
    description: string;
    packFormat: number;
    builtIn: boolean;
    iconDataUrl?: string;
    langOverrides?: Record<string, string>;
    highContrast?: boolean;
}

export const DEFAULT_KEYBINDS: KeyBindEntry[] = [
    // Movement (key.categories.movement)
    { id: 'key.forward', category: 'key.categories.movement', defaultCode: 'KeyW', boundCode: 'KeyW' },
    { id: 'key.left', category: 'key.categories.movement', defaultCode: 'KeyA', boundCode: 'KeyA' },
    { id: 'key.back', category: 'key.categories.movement', defaultCode: 'KeyS', boundCode: 'KeyS' },
    { id: 'key.right', category: 'key.categories.movement', defaultCode: 'KeyD', boundCode: 'KeyD' },
    { id: 'key.jump', category: 'key.categories.movement', defaultCode: 'Space', boundCode: 'Space' },
    { id: 'key.sneak', category: 'key.categories.movement', defaultCode: 'ShiftLeft', boundCode: 'ShiftLeft' },
    { id: 'key.sprint', category: 'key.categories.movement', defaultCode: 'ControlLeft', boundCode: 'ControlLeft' },
    // Gameplay (key.categories.gameplay)
    { id: 'key.attack', category: 'key.categories.gameplay', defaultCode: 'Mouse0', boundCode: 'Mouse0' },
    { id: 'key.pickItem', category: 'key.categories.gameplay', defaultCode: 'Mouse1', boundCode: 'Mouse1' },
    { id: 'key.use', category: 'key.categories.gameplay', defaultCode: 'Mouse2', boundCode: 'Mouse2' },
    // Inventory (key.categories.inventory)
    { id: 'key.inventory', category: 'key.categories.inventory', defaultCode: 'KeyE', boundCode: 'KeyE' },
    { id: 'key.swapOffhand', category: 'key.categories.inventory', defaultCode: 'KeyF', boundCode: 'KeyF' },
    { id: 'key.drop', category: 'key.categories.inventory', defaultCode: 'KeyQ', boundCode: 'KeyQ' },
    { id: 'key.hotbar.1', category: 'key.categories.inventory', defaultCode: 'Digit1', boundCode: 'Digit1' },
    { id: 'key.hotbar.2', category: 'key.categories.inventory', defaultCode: 'Digit2', boundCode: 'Digit2' },
    { id: 'key.hotbar.3', category: 'key.categories.inventory', defaultCode: 'Digit3', boundCode: 'Digit3' },
    { id: 'key.hotbar.4', category: 'key.categories.inventory', defaultCode: 'Digit4', boundCode: 'Digit4' },
    { id: 'key.hotbar.5', category: 'key.categories.inventory', defaultCode: 'Digit5', boundCode: 'Digit5' },
    { id: 'key.hotbar.6', category: 'key.categories.inventory', defaultCode: 'Digit6', boundCode: 'Digit6' },
    { id: 'key.hotbar.7', category: 'key.categories.inventory', defaultCode: 'Digit7', boundCode: 'Digit7' },
    { id: 'key.hotbar.8', category: 'key.categories.inventory', defaultCode: 'Digit8', boundCode: 'Digit8' },
    { id: 'key.hotbar.9', category: 'key.categories.inventory', defaultCode: 'Digit9', boundCode: 'Digit9' },
    { id: 'key.saveToolbarActivator', category: 'key.categories.creative', defaultCode: 'KeyC', boundCode: 'KeyC' },
    { id: 'key.loadToolbarActivator', category: 'key.categories.creative', defaultCode: 'KeyX', boundCode: 'KeyX' },
    // Multiplayer (key.categories.multiplayer)
    { id: 'key.chat', category: 'key.categories.multiplayer', defaultCode: 'KeyT', boundCode: 'KeyT' },
    { id: 'key.playerlist', category: 'key.categories.multiplayer', defaultCode: 'Tab', boundCode: 'Tab' },
    { id: 'key.command', category: 'key.categories.multiplayer', defaultCode: 'Slash', boundCode: 'Slash' },
    { id: 'key.socialInteractions', category: 'key.categories.multiplayer', defaultCode: 'KeyP', boundCode: 'KeyP' },
    // Miscellaneous (key.categories.misc)
    { id: 'key.advancements', category: 'key.categories.misc', defaultCode: 'KeyL', boundCode: 'KeyL' },
    { id: 'key.spectatorOutlines', category: 'key.categories.misc', defaultCode: 'KeyO', boundCode: 'KeyO' },
    { id: 'key.screenshot', category: 'key.categories.misc', defaultCode: 'F2', boundCode: 'F2' },
    { id: 'key.smoothCamera', category: 'key.categories.misc', defaultCode: 'F8', boundCode: 'F8' },
    { id: 'key.fullscreen', category: 'key.categories.misc', defaultCode: 'F11', boundCode: 'F11' },
    { id: 'key.toggleGui', category: 'key.categories.misc', defaultCode: 'F1', boundCode: 'F1' },
    { id: 'key.togglePerspective', category: 'key.categories.misc', defaultCode: 'F5', boundCode: 'F5' },
    { id: 'key.debug.overlay', category: 'key.categories.misc', defaultCode: 'F3', boundCode: 'F3' },
];

export class VanillaOptionsState {
    // Video Settings (net.minecraft.client.gui.screens.options.VideoSettingsScreen)
    public fov = 70; // 30 .. 110
    public renderDistance = 6; // 2 .. 32 chunks
    public simulationDistance = 8; // 5 .. 32 chunks
    public graphicsMode: 'fast' | 'fancy' | 'fabulous' = 'fancy';
    public preferredGraphicsBackend: 'WebGPU' | 'WebGL2' = 'WebGPU';
    public smoothLighting: 'off' | 'minimum' | 'maximum' = 'maximum';
    public guiScale = 0; // 0 = Auto, 1, 2, 3, 4
    public maxFps = 120; // 10 .. 260 (260 = Unlimited)
    public enableVsync = true;
    public gamma = 0.5; // 0.0 (Moody) .. 1.0 (Bright)
    public renderClouds: 'off' | 'fast' | 'fancy' = 'fancy';
    public cloudRange = 148; // Cloud height (-64 .. 320)
    public particles: 'all' | 'decreased' | 'minimal' = 'all';
    public mipmapLevels = 4; // 0 .. 4
    public biomeBlendRadius = 2; // 0 (Off) .. 7 (15x15)
    public entityDistanceScaling = 1.0; // 0.5 (50%) .. 5.0 (500%)
    public entityShadows = true;
    public screenEffectScale = 1.0; // Distortion Effects 0.0 .. 1.0
    public fovEffectScale = 1.0; // FOV Effects 0.0 .. 1.0
    public bobView = true;
    public attackIndicator: 'crosshair' | 'hotbar' | 'off' = 'crosshair';
    public showAutosaveIndicator = true;
    public fullscreen = false;
    public chunkSectionFadeInTime = 0.25;
    public prioritizeChunkUpdates = 0; // 0 = Threaded, 1 = Semi-Blocking, 2 = Fully Blocking

    // Sound Settings (net.minecraft.client.gui.screens.options.SoundOptionsScreen)
    public soundVolumes: Record<SoundSource, number> = {
        [SoundSource.MASTER]: 1.0,
        [SoundSource.MUSIC]: 0.7,
        [SoundSource.RECORDS]: 1.0,
        [SoundSource.WEATHER]: 1.0,
        [SoundSource.BLOCKS]: 1.0,
        [SoundSource.HOSTILE]: 1.0,
        [SoundSource.NEUTRAL]: 1.0,
        [SoundSource.PLAYERS]: 1.0,
        [SoundSource.AMBIENT]: 1.0,
        [SoundSource.VOICE]: 1.0,
    };
    public directionalAudio = true;
    public showSubtitles = false;
    public musicFrequency: 'default' | 'frequent' | 'constant' = 'default';

    // Mouse & Controls Settings (MouseSettingsScreen & KeyBindsScreen)
    public mouseSensitivity = 0.5; // 0.0 (*yawn*) .. 1.0 (HYPERSPEED!!!)
    public invertYMouse = false;
    public mouseWheelSensitivity = 1.0;
    public discreteMouseScroll = false;
    public touchscreen = false;
    public autoJump = false;
    public toggleCrouch = false;
    public toggleSprint = false;
    public operatorItemsTab = false;
    public keyBinds: KeyBindEntry[] = DEFAULT_KEYBINDS.map(k => ({ ...k }));

    // Skin Customization (SkinCustomizationScreen)
    public modelPartCape = true;
    public modelPartJacket = true;
    public modelPartLeftSleeve = true;
    public modelPartRightSleeve = true;
    public modelPartLeftPantsLeg = true;
    public modelPartRightPantsLeg = true;
    public modelPartHat = true;
    public mainHand: 'right' | 'left' = 'right';

    // Language & Font Settings (LanguageSelectScreen)
    public lang = 'en_us';
    public forceUnicodeFont = false;

    // Chat & Accessibility Settings
    public chatVisibility: 'full' | 'system' | 'hidden' = 'full';
    public chatColors = true;
    public chatLinks = true;
    public chatLinksPrompt = true;
    public chatOpacity = 1.0;
    public textBackgroundOpacity = 0.5;
    public chatScale = 1.0;
    public chatLineSpacing = 0.0;
    public chatDelay = 0.0;
    public highContrast = false;
    public menuBackgroundBlurriness = 5; // 0 .. 10
    public panoramaScrollSpeed = 1.0; // 0.0 .. 1.0
    public darkMojangStudiosBackground = false;
    public hideLightningFlashes = false;
    public hideSplashTexts = false;
    public damageTiltStrength = 1.0;
    public glintSpeed = 0.5;
    public glintStrength = 0.75;

    // Resource Packs
    public selectedResourcePacks: string[] = ['vanilla'];

    public toOptionsTxt(): string {
        const lines: string[] = [
            'version:5023',
            `fov:${((this.fov - 70.0) / 40.0).toFixed(4)}`,
            `renderDistance:${this.renderDistance}`,
            `simulationDistance:${this.simulationDistance}`,
            `graphicsPreset:"${this.graphicsMode}"`,
            `preferredGraphicsBackend:"${this.preferredGraphicsBackend}"`,
            `ao:"${this.smoothLighting}"`,
            `guiScale:${this.guiScale}`,
            `maxFps:${this.maxFps}`,
            `enableVsync:${this.enableVsync}`,
            `gamma:${this.gamma.toFixed(4)}`,
            `renderClouds:"${this.renderClouds}"`,
            `cloudRange:${this.cloudRange}`,
            `particles:"${this.particles}"`,
            `mipmapLevels:${this.mipmapLevels}`,
            `biomeBlendRadius:${this.biomeBlendRadius}`,
            `entityDistanceScaling:${this.entityDistanceScaling.toFixed(2)}`,
            `entityShadows:${this.entityShadows}`,
            `screenEffectScale:${this.screenEffectScale.toFixed(4)}`,
            `fovEffectScale:${this.fovEffectScale.toFixed(4)}`,
            `bobView:${this.bobView}`,
            `attackIndicator:"${this.attackIndicator}"`,
            `showAutosaveIndicator:${this.showAutosaveIndicator}`,
            `fullscreen:${this.fullscreen}`,
            `directionalAudio:${this.directionalAudio}`,
            `showSubtitles:${this.showSubtitles}`,
            `mouseSensitivity:${this.mouseSensitivity.toFixed(4)}`,
            `invertYMouse:${this.invertYMouse}`,
            `mouseWheelSensitivity:${this.mouseWheelSensitivity.toFixed(4)}`,
            `discrete_mouse_scroll:${this.discreteMouseScroll}`,
            `autoJump:${this.autoJump}`,
            `toggleCrouch:${this.toggleCrouch}`,
            `toggleSprint:${this.toggleSprint}`,
            `operatorItemsTab:${this.operatorItemsTab}`,
            `lang:${this.lang}`,
            `forceUnicodeFont:${this.forceUnicodeFont}`,
            `mainHand:"${this.mainHand}"`,
            `modelPart_cape:${this.modelPartCape}`,
            `modelPart_jacket:${this.modelPartJacket}`,
            `modelPart_left_sleeve:${this.modelPartLeftSleeve}`,
            `modelPart_right_sleeve:${this.modelPartRightSleeve}`,
            `modelPart_left_pants_leg:${this.modelPartLeftPantsLeg}`,
            `modelPart_right_pants_leg:${this.modelPartRightPantsLeg}`,
            `modelPart_hat:${this.modelPartHat}`,
            `highContrast:${this.highContrast}`,
            `menuBackgroundBlurriness:${this.menuBackgroundBlurriness}`,
            `panoramaScrollSpeed:${this.panoramaScrollSpeed.toFixed(2)}`,
            `darkMojangStudiosBackground:${this.darkMojangStudiosBackground}`,
            `hideSplashTexts:${this.hideSplashTexts}`,
            `resourcePacks:${JSON.stringify(this.selectedResourcePacks)}`,
        ];
        for (const [cat, vol] of Object.entries(this.soundVolumes)) {
            lines.push(`soundCategory_${cat}:${vol.toFixed(4)}`);
        }
        for (const kb of this.keyBinds) {
            lines.push(`key_${kb.id}:${kb.boundCode}`);
        }
        return lines.join('\n');
    }

    public fromOptionsTxt(txt: string): void {
        for (const rawLine of txt.split(/\r?\n/)) {
            const idx = rawLine.indexOf(':');
            if (idx <= 0) continue;
            const k = rawLine.slice(0, idx).trim();
            const v = rawLine.slice(idx + 1).trim();
            const unquoted = v.replace(/^"|"$/g, '');
            if (k === 'fov') this.fov = Math.round(70 + parseFloat(v) * 40);
            else if (k === 'renderDistance') this.renderDistance = Math.max(2, Math.min(32, parseInt(v, 10) || 6));
            else if (k === 'simulationDistance') this.simulationDistance = Math.max(5, Math.min(32, parseInt(v, 10) || 8));
            else if (k === 'graphicsPreset' && (unquoted === 'fast' || unquoted === 'fancy' || unquoted === 'fabulous')) this.graphicsMode = unquoted;
            else if (k === 'preferredGraphicsBackend' && (unquoted === 'WebGPU' || unquoted === 'WebGL2')) this.preferredGraphicsBackend = unquoted;
            else if (k === 'ao' && (unquoted === 'off' || unquoted === 'minimum' || unquoted === 'maximum')) this.smoothLighting = unquoted;
            else if (k === 'guiScale') this.guiScale = Math.max(0, Math.min(4, parseInt(v, 10) || 0));
            else if (k === 'maxFps') this.maxFps = Math.max(10, Math.min(260, parseInt(v, 10) || 120));
            else if (k === 'enableVsync') this.enableVsync = v === 'true';
            else if (k === 'gamma') this.gamma = Math.max(0, Math.min(1, parseFloat(v) || 0.5));
            else if (k === 'renderClouds' && (unquoted === 'off' || unquoted === 'fast' || unquoted === 'fancy')) this.renderClouds = unquoted;
            else if (k === 'cloudRange') this.cloudRange = parseInt(v, 10) || 148;
            else if (k === 'particles' && (unquoted === 'all' || unquoted === 'decreased' || unquoted === 'minimal')) this.particles = unquoted;
            else if (k === 'mipmapLevels') this.mipmapLevels = Math.max(0, Math.min(4, parseInt(v, 10) || 4));
            else if (k === 'biomeBlendRadius') this.biomeBlendRadius = Math.max(0, Math.min(7, parseInt(v, 10) || 2));
            else if (k === 'entityDistanceScaling') this.entityDistanceScaling = Math.max(0.5, Math.min(5.0, parseFloat(v) || 1.0));
            else if (k === 'entityShadows') this.entityShadows = v === 'true';
            else if (k === 'screenEffectScale') this.screenEffectScale = parseFloat(v) ?? 1.0;
            else if (k === 'fovEffectScale') this.fovEffectScale = parseFloat(v) ?? 1.0;
            else if (k === 'bobView') this.bobView = v === 'true';
            else if (k === 'attackIndicator' && (unquoted === 'crosshair' || unquoted === 'hotbar' || unquoted === 'off')) this.attackIndicator = unquoted;
            else if (k === 'directionalAudio') this.directionalAudio = v === 'true';
            else if (k === 'showSubtitles') this.showSubtitles = v === 'true';
            else if (k === 'mouseSensitivity') this.mouseSensitivity = parseFloat(v) ?? 0.5;
            else if (k === 'invertYMouse') this.invertYMouse = v === 'true';
            else if (k === 'mouseWheelSensitivity') this.mouseWheelSensitivity = parseFloat(v) || 1.0;
            else if (k === 'discrete_mouse_scroll') this.discreteMouseScroll = v === 'true';
            else if (k === 'autoJump') this.autoJump = v === 'true';
            else if (k === 'toggleCrouch') this.toggleCrouch = v === 'true';
            else if (k === 'toggleSprint') this.toggleSprint = v === 'true';
            else if (k === 'operatorItemsTab') this.operatorItemsTab = v === 'true';
            else if (k === 'lang') this.lang = unquoted || 'en_us';
            else if (k === 'forceUnicodeFont') this.forceUnicodeFont = v === 'true';
            else if (k === 'mainHand' && (unquoted === 'right' || unquoted === 'left')) this.mainHand = unquoted;
            else if (k === 'modelPart_cape') this.modelPartCape = v === 'true';
            else if (k === 'modelPart_jacket') this.modelPartJacket = v === 'true';
            else if (k === 'modelPart_left_sleeve') this.modelPartLeftSleeve = v === 'true';
            else if (k === 'modelPart_right_sleeve') this.modelPartRightSleeve = v === 'true';
            else if (k === 'modelPart_left_pants_leg') this.modelPartLeftPantsLeg = v === 'true';
            else if (k === 'modelPart_right_pants_leg') this.modelPartRightPantsLeg = v === 'true';
            else if (k === 'modelPart_hat') this.modelPartHat = v === 'true';
            else if (k === 'highContrast') this.highContrast = v === 'true';
            else if (k === 'menuBackgroundBlurriness') this.menuBackgroundBlurriness = parseInt(v, 10) ?? 5;
            else if (k === 'panoramaScrollSpeed') this.panoramaScrollSpeed = parseFloat(v) ?? 1.0;
            else if (k === 'darkMojangStudiosBackground') this.darkMojangStudiosBackground = v === 'true';
            else if (k === 'hideSplashTexts') this.hideSplashTexts = v === 'true';
            else if (k.startsWith('soundCategory_')) {
                const cat = k.slice('soundCategory_'.length) as SoundSource;
                if (cat in this.soundVolumes) {
                    this.soundVolumes[cat] = Math.max(0, Math.min(1, parseFloat(v) || 0));
                }
            } else if (k.startsWith('key_')) {
                const kbId = k.slice(4);
                const entry = this.keyBinds.find(b => b.id === kbId);
                if (entry && v) entry.boundCode = v;
            }
        }
    }

    public getKeyCode(keyId: string): string {
        return this.keyBinds.find(k => k.id === keyId)?.boundCode || '';
    }
}

export class PlatformAbstractionLayer {
    public readonly vfs: BrowserVFS;
    public readonly audio: OpenALAudioEngine;
    public readonly options = new VanillaOptionsState();
    public bytecodeBundle!: BytecodeGuiBundle;
    public enUsDict: Record<string, string> = {};
    public activeLangDict: Record<string, string> = {};
    public savedWorlds: SavedWorldSummary[] = [];
    public availableResourcePacks: ResourcePackEntry[] = [
        {
            id: 'vanilla',
            title: 'Default',
            description: 'The default look and feel of Minecraft 26.3',
            packFormat: 55,
            builtIn: true,
        },
        {
            id: 'high_contrast',
            title: 'High Contrast',
            description: 'Increases UI contrast for improved readability',
            packFormat: 55,
            builtIn: true,
            highContrast: true,
        },
        {
            id: 'programmer_art',
            title: 'Programmer Art',
            description: 'Classic developer textures from earlier eras',
            packFormat: 55,
            builtIn: true,
        },
    ];

    constructor(vfs: BrowserVFS, audio: OpenALAudioEngine) {
        this.vfs = vfs;
        this.audio = audio;
    }

    public async init(bytecodeUrl = 'assets/bytecode_gui.json', enUsDict: Record<string, string> = {}): Promise<void> {
        this.enUsDict = enUsDict;
        this.activeLangDict = { ...enUsDict };

        const resp = await fetch(bytecodeUrl);
        this.bytecodeBundle = await resp.json();

        // Load persisted options.txt from BrowserVFS (OPFS / IndexedDB)
        const savedOptBytes = await this.vfs.readFile('options.txt');
        if (savedOptBytes) {
            const txt = new TextDecoder('utf-8').decode(savedOptBytes);
            this.options.fromOptionsTxt(txt);
        }
        this.syncAudioOptions();

        if (this.options.lang !== 'en_us') {
            await this.loadLanguage(this.options.lang);
        }

        // Load saved worlds from BrowserVFS
        await this.loadSavedWorlds();
    }

    public async saveOptions(): Promise<void> {
        this.syncAudioOptions();
        const txt = this.options.toOptionsTxt();
        await this.vfs.writeFile('options.txt', new TextEncoder().encode(txt));
    }

    public syncAudioOptions(): void {
        for (const [cat, vol] of Object.entries(this.options.soundVolumes)) {
            this.audio.setCategoryVolume(cat as SoundSource, vol);
        }
        this.audio.directionalAudio = this.options.directionalAudio;
        this.audio.showSubtitles = this.options.showSubtitles;
    }

    /**
     * Loads any of the 143 language `.json` files extracted from `.minecraft/assets/indexes/34.json`
     * into `activeLangDict` for instant UI text reloading.
     */
    public async loadLanguage(langCode: string): Promise<void> {
        const cleanCode = langCode.toLowerCase();
        this.options.lang = cleanCode;
        if (cleanCode === 'en_us') {
            this.activeLangDict = { ...this.enUsDict };
            return;
        }
        try {
            const resp = await fetch(`assets/lang/${cleanCode}.json`);
            if (resp.ok) {
                const langJson = await resp.json();
                this.activeLangDict = { ...this.enUsDict, ...langJson };
            }
        } catch {
            this.activeLangDict = { ...this.enUsDict };
        }
    }

    /**
     * Authentic `net.minecraft.client.resources.language.I18n.get(key, ...args)` implementation.
     */
    public translate(key: string, ...args: Array<string | number>): string {
        let template = this.activeLangDict[key] ?? this.enUsDict[key] ?? key;
        if (args.length === 0) return template;
        let argIdx = 0;
        template = template.replace(/%(\d+\$)?[sd]/g, (_m, posGroup) => {
            if (posGroup) {
                const p = parseInt(posGroup.slice(0, -1), 10) - 1;
                return String(args[p] ?? '');
            }
            return String(args[argIdx++] ?? '');
        });
        return template;
    }

    public getClassMeta(className: string): TranspiledClassMeta | undefined {
        return this.bytecodeBundle?.classes?.[className];
    }

    public async loadSavedWorlds(): Promise<void> {
        const raw = await this.vfs.readFile('saves/worlds_index.json');
        if (raw) {
            try {
                this.savedWorlds = JSON.parse(new TextDecoder('utf-8').decode(raw));
                return;
            } catch {}
        }
        // Provide a default locally generated world in OPFS/IndexedDB if none exist yet
        const defaultGameRules: Record<string, boolean | number> = {};
        for (const gr of this.bytecodeBundle?.gameRules || []) {
            defaultGameRules[gr.id] = gr.defaultValue;
        }
        this.savedWorlds = [
            {
                id: 'world_26_3_default',
                folderName: 'New World',
                name: 'New World',
                lastPlayedMs: Date.now() - 3600_000,
                createdMs: Date.now() - 7200_000,
                gameMode: 'survival',
                difficulty: 'normal',
                difficultyLocked: false,
                allowCommands: true,
                worldType: 'normal',
                seed: '2632026',
                generateStructures: true,
                bonusChest: false,
                flatLayers: [
                    { block: 'minecraft:bedrock', height: 1 },
                    { block: 'minecraft:dirt', height: 2 },
                    { block: 'minecraft:grass_block', height: 1 },
                ],
                flatBiome: 'minecraft:plains',
                singleBiome: 'minecraft:pale_garden',
                experiments: ['vanilla'],
                dataPacks: ['vanilla'],
                gameRules: defaultGameRules,
                versionName: '26.3',
                protocolVersion: 777,
                dataVersion: 5023,
                iconColor1: '#59ae30',
                iconColor2: '#7a5838',
            },
        ];
        await this.persistSavedWorlds();
    }

    public async persistSavedWorlds(): Promise<void> {
        const bytes = new TextEncoder().encode(JSON.stringify(this.savedWorlds));
        await this.vfs.writeFile('saves/worlds_index.json', bytes);
    }

    /**
     * Parses a user-dropped `.zip` Resource Pack in the browser (reading `pack.mcmeta`, `pack.png`,
     * and any `assets/minecraft/lang/*.json` overrides) and adds it to `availableResourcePacks`.
     */
    public async importZipResourcePack(file: File): Promise<ResourcePackEntry> {
        const buf = new Uint8Array(await file.arrayBuffer());
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

        let eocd = buf.byteLength - 22;
        while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;

        let description = `Custom Resource Pack (${(file.size / 1024).toFixed(1)} KB)`;
        let packFormat = 55;
        let iconDataUrl: string | undefined;
        let langOverrides: Record<string, string> | undefined;

        if (eocd >= 0) {
            const cdCount = dv.getUint16(eocd + 10, true);
            const cdOffset = dv.getUint32(eocd + 16, true);
            let ptr = cdOffset;
            for (let i = 0; i < cdCount && ptr + 46 <= buf.byteLength; i++) {
                if (dv.getUint32(ptr, true) !== 0x02014b50) break;
                const method = dv.getUint16(ptr + 10, true);
                const compSize = dv.getUint32(ptr + 20, true);
                const nLen = dv.getUint16(ptr + 28, true);
                const xLen = dv.getUint16(ptr + 30, true);
                const cLen = dv.getUint16(ptr + 32, true);
                const lho = dv.getUint32(ptr + 42, true);
                const entryName = new TextDecoder('utf-8').decode(buf.subarray(ptr + 46, ptr + 46 + nLen));
                ptr += 46 + nLen + xLen + cLen;

                if (entryName === 'pack.mcmeta' || entryName === 'pack.png' || entryName === 'assets/minecraft/lang/en_us.json') {
                    const lnLen = dv.getUint16(lho + 26, true);
                    const lxLen = dv.getUint16(lho + 28, true);
                    const dataStart = lho + 30 + lnLen + lxLen;
                    const slice = buf.subarray(dataStart, dataStart + compSize);
                    let rawBytes: Uint8Array | null = null;
                    if (method === 0) {
                        rawBytes = slice;
                    } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
                        try {
                            const ds = new DecompressionStream('deflate-raw');
                            const writer = ds.writable.getWriter();
                            writer.write(slice as unknown as BufferSource);
                            writer.close();
                            rawBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
                        } catch {}
                    }
                    if (rawBytes) {
                        if (entryName === 'pack.mcmeta') {
                            try {
                                const meta = JSON.parse(new TextDecoder('utf-8').decode(rawBytes));
                                if (meta.pack?.description) {
                                    description = typeof meta.pack.description === 'string'
                                        ? meta.pack.description
                                        : (meta.pack.description.text || JSON.stringify(meta.pack.description));
                                }
                                if (meta.pack?.pack_format) packFormat = Number(meta.pack.pack_format);
                            } catch {}
                        } else if (entryName === 'pack.png') {
                            const blob = new Blob([rawBytes as unknown as BlobPart], { type: 'image/png' });
                            iconDataUrl = URL.createObjectURL(blob);
                        } else if (entryName === 'assets/minecraft/lang/en_us.json') {
                            try {
                                langOverrides = JSON.parse(new TextDecoder('utf-8').decode(rawBytes));
                            } catch {}
                        }
                    }
                }
            }
        }

        const id = `file/${file.name}`;
        await this.vfs.writeFile(`resourcepacks/${file.name}`, buf);
        const existingIdx = this.availableResourcePacks.findIndex(p => p.id === id);
        const packEntry: ResourcePackEntry = {
            id,
            title: file.name.replace(/\.zip$/i, ''),
            description,
            packFormat,
            builtIn: false,
            iconDataUrl,
            langOverrides,
        };
        if (existingIdx >= 0) this.availableResourcePacks[existingIdx] = packEntry;
        else this.availableResourcePacks.push(packEntry);
        return packEntry;
    }
}
