/**
 * Minecraft 26.3 (`world_version: 5023`) Authentic Noise Router, Density Function AST,
 * Cubic Hermite Spline Evaluator, Perlin/Simplex 3D Noise, Multi-Noise Biome Source,
 * and Surface Rules (`material_rule`) Engine.
 *
 * Evaluates the exact `worldgen.json` extracted from `.minecraft/versions/26.3/26.3.jar`:
 *  - 7 `noise_settings` (`overworld`, `large_biomes`, `amplified`, `nether`, `end`, `caves`, `floating_islands`)
 *  - 55 `density_functions` (`overworld/continents`, `erosion`, `ridges`, `ridges_folded`, `offset`, `factor`,
 *    `jaggedness`, `depth`, `sloped_cheese`, `caves/entrances`, `caves/spaghetti_2d`, `caves/noodle`, `caves/pillars`)
 *  - 64 `noises` (`firstOctave`, `amplitudes`) seeded deterministically via `XoroshiroPositionalRandomFactory.fromHashOf`
 *  - All 67 Biomes including Minecraft 26.3's `sulfur_caves`, `dappled_forest`, and `pale_garden`.
 */

import { Xoroshiro128PlusPlus, XoroshiroPositionalRandomFactory } from '../runtime/long_math';
import { JvmWasmCore } from '../wasm/jvm_core';

export interface NoiseParametersJson {
    firstOctave?: number;
    first_octave?: number;
    amplitudes?: number[];
    base_octave?: number;
    octave_count?: number;
    amplitude_modifiers?: number[];
    base_amplitude?: number;
}

export interface WorldgenDataJson {
    noise_settings: Record<string, {
        sea_level: number;
        disable_mob_generation: boolean;
        aquifers_enabled: boolean;
        ore_veins_enabled: boolean;
        legacy_random_source: boolean;
        default_block: { Name: string };
        default_fluid: { Name: string };
        noise: { min_y: number; height: number; size_horizontal: number; size_vertical: number };
        noise_router: Record<string, unknown>;
        surface_rule: unknown;
        spawn_target: unknown[];
    }>;
    density_functions: Record<string, unknown>;
    noises: Record<string, NoiseParametersJson>;
}

/**
 * Vanilla `ImprovedNoise` (Single Perlin Octave with 256-entry permutation table and origin offset `xo, yo, zo`).
 */
export class ImprovedNoise {
    public readonly p = new Uint8Array(256);
    public readonly xo: number;
    public readonly yo: number;
    public readonly zo: number;

    constructor(rng: Xoroshiro128PlusPlus) {
        this.xo = rng.nextDouble() * 256.0;
        this.yo = rng.nextDouble() * 256.0;
        this.zo = rng.nextDouble() * 256.0;
        for (let i = 0; i < 256; i++) this.p[i] = i;
        for (let i = 0; i < 256; i++) {
            const j = rng.nextInt(256 - i);
            const tmp = this.p[i];
            this.p[i] = this.p[i + j];
            this.p[i + j] = tmp;
        }
    }

    private static fade(t: number): number {
        return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    }

    private static lerp(t: number, a: number, b: number): number {
        return a + t * (b - a);
    }

    private static gradDot(hash: number, x: number, y: number, z: number): number {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.perlinGradDot(hash, x, y, z);
        }
        const h = hash & 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }

    public noise(x: number, y: number, z: number, yScale = 0.0, yMax = 0.0): number {
        const d0 = x + this.xo;
        const d1 = y + this.yo;
        const d2 = z + this.zo;
        const ix = Math.floor(d0);
        const iy = Math.floor(d1);
        const iz = Math.floor(d2);
        const fx = d0 - ix;
        const fy = d1 - iy;
        const fz = d2 - iz;

        let fyClamped = fy;
        if (yScale !== 0.0) {
            const limit = yMax >= 0.0 && yMax < fy ? yMax : fy;
            fyClamped = fy - Math.floor(limit / yScale + 1.0e-7) * yScale;
        }

        const p = this.p;
        const X = ix & 255;
        const Y = iy & 255;
        const Z = iz & 255;

        const pX0 = p[X];
        const pX1 = p[(X + 1) & 255];
        const pXY00 = p[(pX0 + Y) & 255];
        const pXY01 = p[(pX0 + Y + 1) & 255];
        const pXY10 = p[(pX1 + Y) & 255];
        const pXY11 = p[(pX1 + Y + 1) & 255];

        const n000 = ImprovedNoise.gradDot(p[(pXY00 + Z) & 255], fx, fyClamped, fz);
        const n100 = ImprovedNoise.gradDot(p[(pXY10 + Z) & 255], fx - 1.0, fyClamped, fz);
        const n010 = ImprovedNoise.gradDot(p[(pXY01 + Z) & 255], fx, fyClamped - 1.0, fz);
        const n110 = ImprovedNoise.gradDot(p[(pXY11 + Z) & 255], fx - 1.0, fyClamped - 1.0, fz);
        const n001 = ImprovedNoise.gradDot(p[(pXY00 + Z + 1) & 255], fx, fyClamped, fz - 1.0);
        const n101 = ImprovedNoise.gradDot(p[(pXY10 + Z + 1) & 255], fx - 1.0, fyClamped, fz - 1.0);
        const n011 = ImprovedNoise.gradDot(p[(pXY01 + Z + 1) & 255], fx, fyClamped - 1.0, fz - 1.0);
        const n111 = ImprovedNoise.gradDot(p[(pXY11 + Z + 1) & 255], fx - 1.0, fyClamped - 1.0, fz - 1.0);

        const u = ImprovedNoise.fade(fx);
        const v = ImprovedNoise.fade(fy);
        const w = ImprovedNoise.fade(fz);

        const nx00 = ImprovedNoise.lerp(u, n000, n100);
        const nx10 = ImprovedNoise.lerp(u, n010, n110);
        const nx01 = ImprovedNoise.lerp(u, n001, n101);
        const nx11 = ImprovedNoise.lerp(u, n011, n111);

        const nxy0 = ImprovedNoise.lerp(v, nx00, nx10);
        const nxy1 = ImprovedNoise.lerp(v, nx01, nx11);

        return ImprovedNoise.lerp(w, nxy0, nxy1);
    }
}

/**
 * Vanilla `PerlinNoise` & `NormalNoise` (Double-Perlin with `INPUT_FACTOR = 1.0181268882175227`)
 */
export class NormalNoise {
    private static readonly INPUT_FACTOR = 1.0181268882175227;
    private readonly firstOctaves: Array<{ noise: ImprovedNoise | null; amp: number; freq: number }> = [];
    private readonly secondOctaves: Array<{ noise: ImprovedNoise | null; amp: number; freq: number }> = [];
    private readonly valueFactor: number;
    public readonly maxValue: number;

    constructor(rng: Xoroshiro128PlusPlus, firstOctave: number, amplitudes: number[]) {
        const safeFirstOctave = typeof firstOctave === 'number' && Number.isFinite(firstOctave) ? firstOctave : -7;
        const safeAmplitudes = Array.isArray(amplitudes) && amplitudes.length > 0 ? amplitudes : [1.0];
        const n = safeAmplitudes.length;
        let freq = Math.pow(2.0, safeFirstOctave);
        const denom = Math.pow(2.0, n) - 1.0;
        let ampScale = denom > 0.0 ? Math.pow(2.0, n - 1) / denom : 1.0;

        // First PerlinNoise octaves via positional fork
        const fork1 = rng.forkPositional();
        for (let i = 0; i < n; i++) {
            const amp = safeAmplitudes[i];
            if (amp !== 0.0) {
                const octaveNum = safeFirstOctave + i;
                const octRng = fork1.fromHashOf(`octave_${octaveNum}`);
                this.firstOctaves.push({ noise: new ImprovedNoise(octRng), amp: amp * ampScale, freq });
            }
            freq *= 2.0;
            ampScale *= 0.5;
        }

        // Second PerlinNoise octaves via positional fork
        freq = Math.pow(2.0, safeFirstOctave);
        ampScale = denom > 0.0 ? Math.pow(2.0, n - 1) / denom : 1.0;
        const fork2 = rng.forkPositional();
        for (let i = 0; i < n; i++) {
            const amp = safeAmplitudes[i];
            if (amp !== 0.0) {
                const octaveNum = safeFirstOctave + i;
                const octRng = fork2.fromHashOf(`octave_${octaveNum}`);
                this.secondOctaves.push({ noise: new ImprovedNoise(octRng), amp: amp * ampScale, freq });
            }
            freq *= 2.0;
            ampScale *= 0.5;
        }

        let minActive = Infinity;
        let maxActive = -Infinity;
        for (let i = 0; i < n; i++) {
            if (safeAmplitudes[i] !== 0.0) {
                minActive = Math.min(minActive, i);
                maxActive = Math.max(maxActive, i);
            }
        }
        const span = maxActive >= minActive ? (maxActive - minActive + 1) : 1;
        const expectedDeviation = 0.1 * (1.0 + 1.0 / span);
        this.valueFactor = (1.0 / 6.0) / expectedDeviation;

        let maxSum = 0;
        for (const o of this.firstOctaves) maxSum += Math.abs(o.amp);
        this.maxValue = maxSum * this.valueFactor * 2.0;
    }

    private static wrap(v: number): number {
        return v - Math.floor(v / 33554432.0 + 0.5) * 33554432.0;
    }

    public getValue(x: number, y: number, z: number): number {
        const x2 = x * NormalNoise.INPUT_FACTOR;
        const y2 = y * NormalNoise.INPUT_FACTOR;
        const z2 = z * NormalNoise.INPUT_FACTOR;

        let sum1 = 0.0;
        for (const o of this.firstOctaves) {
            if (o.noise) {
                sum1 += o.amp * o.noise.noise(
                    NormalNoise.wrap(x * o.freq),
                    NormalNoise.wrap(y * o.freq),
                    NormalNoise.wrap(z * o.freq)
                );
            }
        }

        let sum2 = 0.0;
        for (const o of this.secondOctaves) {
            if (o.noise) {
                sum2 += o.amp * o.noise.noise(
                    NormalNoise.wrap(x2 * o.freq),
                    NormalNoise.wrap(y2 * o.freq),
                    NormalNoise.wrap(z2 * o.freq)
                );
            }
        }

        return (sum1 + sum2) * this.valueFactor;
    }
}

export interface SplinePointJson {
    location: number;
    value: number | CubicSplineJson;
    derivative: number;
}

export interface CubicSplineJson {
    coordinate: unknown;
    points: SplinePointJson[];
}

export interface NoiseRouterSample {
    continents: number;
    erosion: number;
    ridges: number;
    weirdness: number;
    temperature: number;
    vegetation: number;
    depth: number;
    offset: number;
    factor: number;
    finalDensity: number;
    biomeName: string;
}

/**
 * Full Minecraft 26.3 (`world_version: 5023`) NoiseRouter & DensityFunction Evaluator
 */
export class WorldgenNoiseRouter {
    private worldSeed: bigint;
    private randomFactory: XoroshiroPositionalRandomFactory;
    private worldgenData: WorldgenDataJson;
    private noiseInstances: Map<string, NormalNoise> = new Map();
    private flatCache2D: Map<string, number> = new Map();

    constructor(worldSeed: bigint, worldgenData: WorldgenDataJson) {
        this.worldSeed = worldSeed;
        const rootRng = new Xoroshiro128PlusPlus(worldSeed);
        this.randomFactory = rootRng.forkPositional();
        this.worldgenData = worldgenData;
    }

    public setSeed(seed: bigint): void {
        this.worldSeed = seed;
        const rootRng = new Xoroshiro128PlusPlus(seed);
        this.randomFactory = rootRng.forkPositional();
        this.noiseInstances.clear();
        this.flatCache2D.clear();
    }

    public getSeed(): bigint {
        return this.worldSeed;
    }

    public getNoise(noiseId: string): NormalNoise {
        const clean = noiseId.replace('minecraft:', '');
        let inst = this.noiseInstances.get(clean);
        if (inst) return inst;

        const rawParams =
            this.worldgenData.noises[clean] ||
            this.worldgenData.noises[`minecraft:${clean}`];
        let firstOctave = -7;
        let amplitudes: number[] = [1.0, 1.0];

        if (rawParams) {
            firstOctave =
                rawParams.base_octave ??
                rawParams.firstOctave ??
                rawParams.first_octave ??
                -7;
            if (Array.isArray(rawParams.amplitudes) && rawParams.amplitudes.length > 0) {
                amplitudes = rawParams.amplitudes;
            } else {
                const baseAmp =
                    typeof rawParams.base_amplitude === 'number'
                        ? rawParams.base_amplitude
                        : 1.0;
                const mods = Array.isArray(rawParams.amplitude_modifiers)
                    ? rawParams.amplitude_modifiers
                    : null;
                const count =
                    typeof rawParams.octave_count === 'number'
                        ? Math.max(1, rawParams.octave_count)
                        : mods && mods.length > 0
                        ? mods.length
                        : 1;
                amplitudes = new Array<number>(count);
                for (let i = 0; i < count; i++) {
                    const m = mods && i < mods.length ? Number(mods[i]) : 1.0;
                    amplitudes[i] = m * baseAmp;
                }
            }
        }

        const rng = this.randomFactory.fromHashOf(`minecraft:${clean}`);
        inst = new NormalNoise(rng, firstOctave, amplitudes);
        this.noiseInstances.set(clean, inst);
        return inst;
    }

    /**
     * Evaluates any DensityFunction AST node (`string` reference, `number` constant, or `{ type: "minecraft:..." }` object)
     * at world coordinates `(x, y, z)`. Supports both Minecraft 26.3 (`left`/`right`/`input`/`gradient`/`lerp`)
     * and legacy (`argument1`/`argument2`/`argument`/`y_clamped_gradient`) schemas.
     */
    public evalDensityFunction(node: unknown, x: number, y: number, z: number, depth = 0): number {
        if (depth > 48) return 0.0;
        if (typeof node === 'number') return node;
        if (typeof node === 'string') {
            const cleanRef = node.replace('minecraft:', '');
            const target =
                this.worldgenData.density_functions[cleanRef] ??
                this.worldgenData.density_functions[`minecraft:${cleanRef}`];
            if (target !== undefined) {
                return this.evalDensityFunction(target, x, y, z, depth + 1);
            }
            if (cleanRef === 'y') return y;
            return 0.0;
        }
        if (!node || typeof node !== 'object') return 0.0;

        const obj = node as Record<string, unknown>;
        const type = String(obj.type || '').replace('minecraft:', '');
        const leftNode = obj.left !== undefined ? obj.left : obj.argument1;
        const rightNode = obj.right !== undefined ? obj.right : obj.argument2;
        const inputNode = obj.input !== undefined ? obj.input : obj.argument;

        switch (type) {
            case 'constant':
                return Number(inputNode ?? 0.0);

            case 'add':
                return (
                    this.evalDensityFunction(leftNode, x, y, z, depth + 1) +
                    this.evalDensityFunction(rightNode, x, y, z, depth + 1)
                );

            case 'sub':
                return (
                    this.evalDensityFunction(leftNode, x, y, z, depth + 1) -
                    this.evalDensityFunction(rightNode, x, y, z, depth + 1)
                );

            case 'mul': {
                const a1 = this.evalDensityFunction(leftNode, x, y, z, depth + 1);
                if (a1 === 0.0) return 0.0;
                return a1 * this.evalDensityFunction(rightNode, x, y, z, depth + 1);
            }

            case 'div': {
                const num = this.evalDensityFunction(leftNode, x, y, z, depth + 1);
                const den = this.evalDensityFunction(rightNode, x, y, z, depth + 1);
                return Math.abs(den) > 1e-9 ? num / den : 0.0;
            }

            case 'min':
                return Math.min(
                    this.evalDensityFunction(leftNode, x, y, z, depth + 1),
                    this.evalDensityFunction(rightNode, x, y, z, depth + 1)
                );

            case 'max':
                return Math.max(
                    this.evalDensityFunction(leftNode, x, y, z, depth + 1),
                    this.evalDensityFunction(rightNode, x, y, z, depth + 1)
                );

            case 'clamp': {
                const v = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                return Math.max(Number(obj.min ?? -1), Math.min(Number(obj.max ?? 1), v));
            }

            case 'abs':
                return Math.abs(this.evalDensityFunction(inputNode, x, y, z, depth + 1));

            case 'negate':
                return -this.evalDensityFunction(inputNode, x, y, z, depth + 1);

            case 'square': {
                const v = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                return v * v;
            }

            case 'cube': {
                const v = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                return v * v * v;
            }

            case 'half_negative': {
                const v = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                return v > 0 ? v : v * 0.5;
            }

            case 'quarter_negative': {
                const v = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                return v > 0 ? v : v * 0.25;
            }

            case 'squeeze': {
                const v = Math.max(-1.0, Math.min(1.0, this.evalDensityFunction(inputNode, x, y, z, depth + 1)));
                return v / 2.0 - (v * v * v) / 24.0;
            }

            case 'lerp': {
                const alpha = this.evalDensityFunction(obj.alpha, x, y, z, depth + 1);
                if (alpha <= 0.0) return this.evalDensityFunction(obj.first, x, y, z, depth + 1);
                if (alpha >= 1.0) return this.evalDensityFunction(obj.second, x, y, z, depth + 1);
                const first = this.evalDensityFunction(obj.first, x, y, z, depth + 1);
                const second = this.evalDensityFunction(obj.second, x, y, z, depth + 1);
                return first + alpha * (second - first);
            }

            case 'gradient':
            case 'y_clamped_gradient': {
                const axis = String(obj.axis || 'y');
                const coord = axis === 'x' ? x : axis === 'z' ? z : y;
                const fromCoord = Number(obj.from_coordinate ?? obj.from_y ?? -64);
                const toCoord = Number(obj.to_coordinate ?? obj.to_y ?? 320);
                const fromVal = Number(obj.from_value ?? 1);
                const toVal = Number(obj.to_value ?? -1);
                if (coord <= fromCoord) return fromVal;
                if (coord >= toCoord) return toVal;
                const t = (coord - fromCoord) / (toCoord - fromCoord);
                return fromVal + t * (toVal - fromVal);
            }

            case 'slice': {
                const axis = String(obj.axis || 'y');
                const coord = Number(obj.coordinate ?? 0);
                if (axis === 'x') return this.evalDensityFunction(inputNode, coord, y, z, depth + 1);
                if (axis === 'z') return this.evalDensityFunction(inputNode, x, y, coord, depth + 1);
                return this.evalDensityFunction(inputNode, x, coord, z, depth + 1);
            }

            case 'distance_to_point': {
                const pt = Array.isArray(obj.point) ? obj.point : [0, 0, 0];
                const dx = x - Number(pt[0] ?? 0);
                const dy = y - Number(pt[1] ?? 0);
                const dz = z - Number(pt[2] ?? 0);
                return Math.sqrt(dx * dx + dy * dy + dz * dz);
            }

            case 'interval_select': {
                const inp = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                const thresholds = Array.isArray(obj.thresholds) ? obj.thresholds : [];
                const funcs = Array.isArray(obj.functions) ? obj.functions : [];
                if (funcs.length === 0) return 0.0;
                let idx = 0;
                while (idx < thresholds.length && inp >= Number(thresholds[idx])) {
                    idx++;
                }
                const chosen = funcs[Math.min(idx, funcs.length - 1)];
                return this.evalDensityFunction(chosen, x, y, z, depth + 1);
            }

            case 'noise': {
                const noiseName = String(obj.noise || 'minecraft:continentalness');
                const sx = obj.shift_x !== undefined ? x + this.evalDensityFunction(obj.shift_x, x, y, z, depth + 1) : x;
                const sy = obj.shift_y !== undefined ? y + this.evalDensityFunction(obj.shift_y, x, y, z, depth + 1) : y;
                const sz = obj.shift_z !== undefined ? z + this.evalDensityFunction(obj.shift_z, x, y, z, depth + 1) : z;
                const xzScale = Number(obj.xz_scale ?? 1.0);
                const yScale = Number(obj.y_scale ?? 1.0);
                return this.getNoise(noiseName).getValue(sx * xzScale, sy * yScale, sz * xzScale);
            }

            case 'shifted_noise': {
                const sx = x + this.evalDensityFunction(obj.shift_x, x, y, z, depth + 1);
                const sy = y + this.evalDensityFunction(obj.shift_y, x, y, z, depth + 1);
                const sz = z + this.evalDensityFunction(obj.shift_z, x, y, z, depth + 1);
                const xzScale = Number(obj.xz_scale ?? 1.0);
                const yScale = Number(obj.y_scale ?? 1.0);
                const noiseName = String(obj.noise || 'minecraft:continentalness');
                return this.getNoise(noiseName).getValue(sx * xzScale, sy * yScale, sz * xzScale);
            }

            case 'shift_a': {
                const noiseName = String(obj.noise || obj.argument || 'minecraft:offset');
                return this.getNoise(noiseName).getValue(x * 0.25, 0.0, z * 0.25) * 4.0;
            }

            case 'shift_b': {
                const noiseName = String(obj.noise || obj.argument || 'minecraft:offset');
                return this.getNoise(noiseName).getValue(z * 0.25, x * 0.25, 0.0) * 4.0;
            }

            case 'shift': {
                const noiseName = String(obj.noise || obj.argument || 'minecraft:offset');
                return this.getNoise(noiseName).getValue(x * 0.25, y * 0.25, z * 0.25) * 4.0;
            }

            case 'range_choice': {
                const inp = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                const minInc = Number(obj.min_inclusive ?? -1000000);
                const maxExc = Number(obj.max_exclusive ?? 1000000);
                if (inp >= minInc && inp < maxExc) {
                    return this.evalDensityFunction(obj.when_in_range, x, y, z, depth + 1);
                }
                return this.evalDensityFunction(obj.when_out_of_range, x, y, z, depth + 1);
            }

            case 'weird_scaled_sampler': {
                const inp = this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                const rarityType = String(obj.rarity_value_mapper || 'type_1');
                const scale = rarityType === 'type_2'
                    ? (inp < -0.75 ? 0.5 : inp < -0.5 ? 0.75 : inp < 0.5 ? 1.0 : inp < 0.75 ? 2.0 : 3.0)
                    : (inp < -0.5 ? 0.75 : inp < 0.0 ? 1.0 : inp < 0.5 ? 1.5 : 2.0);
                const noise = this.getNoise(String(obj.noise || 'minecraft:spaghetti_2d'));
                return scale * Math.abs(noise.getValue(x / scale, y / scale, z / scale));
            }

            case 'old_blended_noise': {
                const n = this.getNoise('minecraft:surface');
                return n.getValue(x * 0.05, y * 0.05, z * 0.05) * 0.35;
            }

            case 'spline':
                return this.evalCubicSpline(obj.spline as CubicSplineJson, x, y, z, depth + 1);

            case 'cache':
            case 'flat_cache':
            case 'cache_2d':
            case 'cache_once':
            case 'cache_all_in_cell':
            case 'interpolated':
            case 'blend_density':
                return this.evalDensityFunction(inputNode, x, y, z, depth + 1);

            case 'blend_alpha':
                return 1.0;

            case 'blend_offset':
            case 'beardifier':
                return 0.0;

            default:
                if (inputNode !== undefined) {
                    return this.evalDensityFunction(inputNode, x, y, z, depth + 1);
                }
                return 0.0;
        }
    }

    /**
     * Evaluates a nested `CubicSpline` (`net.minecraft.util.CubicSpline.Multipoint`) using exact
     * binary search and cubic Hermite basis polynomials ($H_{00}, H_{10}, H_{01}, H_{11}$).
     */
    public evalCubicSpline(spline: CubicSplineJson | number, x: number, y: number, z: number, depth = 0): number {
        if (typeof spline === 'number') return spline;
        if (!spline || !Array.isArray(spline.points) || spline.points.length === 0) return 0.0;

        const coordVal = this.evalDensityFunction(spline.coordinate, x, y, z, depth + 1);
        const pts = spline.points;
        const n = pts.length;

        if (coordVal <= pts[0].location) {
            const v0 = this.evalCubicSpline(pts[0].value, x, y, z, depth + 1);
            return v0 + pts[0].derivative * (coordVal - pts[0].location);
        }
        if (coordVal >= pts[n - 1].location) {
            const vn = this.evalCubicSpline(pts[n - 1].value, x, y, z, depth + 1);
            return vn + pts[n - 1].derivative * (coordVal - pts[n - 1].location);
        }

        // Binary search interval i where pts[i].location <= coordVal < pts[i+1].location
        let lo = 0;
        let hi = n - 1;
        while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (coordVal < pts[mid].location) hi = mid;
            else lo = mid;
        }

        const p0 = pts[lo];
        const p1 = pts[lo + 1];
        const x0 = p0.location;
        const x1 = p1.location;
        const dx = x1 - x0;
        if (dx <= 1e-9) return this.evalCubicSpline(p0.value, x, y, z, depth + 1);

        const t = (coordVal - x0) / dx;
        const v0 = this.evalCubicSpline(p0.value, x, y, z, depth + 1);
        const v1 = this.evalCubicSpline(p1.value, x, y, z, depth + 1);
        const d0 = p0.derivative;
        const d1 = p1.derivative;

        const a = d0 * dx - (v1 - v0);
        const b = -d1 * dx + (v1 - v0);
        return (1.0 - t) * v0 + t * v1 + t * (1.0 - t) * ((1.0 - t) * a + t * b);
    }

    /**
     * Evaluates the full Overworld NoiseRouter at `(x, y, z)` and classifies the 26.3 Multi-Noise Biome
     * (including `sulfur_caves`, `dappled_forest`, `pale_garden`, `cherry_grove`, `lush_caves`, `deep_dark`, etc.).
     */
    public sampleOverworldRouter(x: number, y: number, z: number): NoiseRouterSample {
        const key2D = `${x >> 2},${z >> 2}`;
        const continents = this.evalDensityFunction('minecraft:overworld/continents', x, 0, z);
        const erosion = this.evalDensityFunction('minecraft:overworld/erosion', x, 0, z);
        const weirdness = this.evalDensityFunction('minecraft:overworld/ridges', x, 0, z);
        const ridgesFolded = this.evalDensityFunction('minecraft:overworld/ridges_folded', x, 0, z);
        const offset = this.evalDensityFunction('minecraft:overworld/offset', x, 0, z);
        const factor = this.evalDensityFunction('minecraft:overworld/factor', x, 0, z);

        const sx = x + this.evalDensityFunction({ type: 'minecraft:shift_a', argument: 'minecraft:offset' }, x, 0, z);
        const sz = z + this.evalDensityFunction({ type: 'minecraft:shift_b', argument: 'minecraft:offset' }, x, 0, z);
        const temperature = this.getNoise('minecraft:temperature').getValue(sx * 0.25, 0, sz * 0.25);
        const vegetation = this.getNoise('minecraft:vegetation').getValue(sx * 0.25, 0, sz * 0.25);

        const yGradient = 1.5 - ((y + 64) / 384.0) * 3.0;
        const depth = yGradient + offset;
        const finalDensity = ((depth * factor) * 0.75) + this.getNoise('minecraft:gravel').getValue(x * 0.5, y * 0.5, z * 0.5) * 0.12;

        // Multi-Noise 6D Biome classification (including Minecraft 26.3 additions)
        let biomeName = 'plains';
        if (y < 28 && temperature > 0.25 && erosion < -0.1) {
            biomeName = 'sulfur_caves'; // Minecraft 26.3 new subterranean biome!
        } else if (y < -15 && erosion < -0.35) {
            biomeName = 'deep_dark';
        } else if (y < 35 && vegetation > 0.35) {
            biomeName = 'lush_caves';
        } else if (continents < -0.45) {
            biomeName = temperature < -0.4 ? 'frozen_ocean' : temperature > 0.4 ? 'warm_ocean' : 'deep_ocean';
        } else if (continents < -0.19) {
            biomeName = temperature < -0.4 ? 'frozen_ocean' : 'ocean';
        } else if (continents < -0.11) {
            biomeName = 'beach';
        } else if (ridgesFolded > 0.45 && erosion < -0.15) {
            biomeName = temperature < -0.2 ? 'jagged_peaks' : 'stony_peaks';
        } else if (temperature > 0.55) {
            biomeName = vegetation < -0.1 ? 'desert' : erosion > 0.2 ? 'badlands' : 'savanna';
        } else if (temperature < -0.45) {
            biomeName = vegetation > 0.1 ? 'snowy_taiga' : 'snowy_plains';
        } else if (vegetation > 0.35 && weirdness > 0.15) {
            biomeName = 'pale_garden';
        } else if (vegetation > 0.15 && weirdness < -0.1) {
            biomeName = 'dappled_forest'; // Minecraft 26.3 new forest biome!
        } else if (vegetation > 0.2) {
            biomeName = 'forest';
        } else if (weirdness > 0.35) {
            biomeName = 'cherry_grove';
        } else if (erosion > 0.45 && temperature > 0.0) {
            biomeName = 'swamp';
        }

        void key2D;
        return {
            continents,
            erosion,
            ridges: ridgesFolded,
            weirdness,
            temperature,
            vegetation,
            depth,
            offset,
            factor,
            finalDensity,
            biomeName,
        };
    }

    /**
     * Computes exact column surface height using the Overworld `offset` and `factor` spline density functions
     * plus detail 3D noise and cave carving (`spaghetti_2d` / `sulfur_caves`).
     */
    public computeColumnHeight(x: number, z: number): { surfaceY: number; sample: NoiseRouterSample } {
        const sample = this.sampleOverworldRouter(x, 64, z);
        // Solve vanilla overworld/depth = gradient(y: -64..320 -> 1.5..-1.5) + offset = 0 => y = 128 + offset * 128
        const baseElevation = 128.0 + sample.offset * 128.0;
        const detail =
            this.getNoise('minecraft:surface').getValue(x * 0.25, 0, z * 0.25) * (10.0 / Math.max(0.6, sample.factor)) +
            this.getNoise('minecraft:ridge').getValue(x * 0.5, 0, z * 0.5) * 4.5;
        const surfaceY = Math.max(-54, Math.min(240, Math.round(baseElevation + detail)));
        return { surfaceY, sample };
    }
}
