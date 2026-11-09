/**
 * Java 64-bit `long` Math, `BlockPos`, `ChunkPos`, `SectionPos`, and `Xoroshiro128++` PRNG
 *
 * Strictly preserves 64-bit signed two's complement integer semantics (`i64` / `BigInt`)
 * required by Minecraft 26.3 (`world_version: 5023`) seed mixing, Stafford13 avalanche,
 * MD5 positional seed forking, and bit-packed coordinates.
 */

import { JvmWasmCore } from '../wasm/jvm_core';

export const MASK_64 = 0xffffffffffffffffn;
export const SIGN_BIT_64 = 0x8000000000000000n;
export const GOLDEN_RATIO_64 = -7046029254386353131n; // 0x9e3779b97f4a7c15
export const SILVER_RATIO_64 = 7640891576956012809n;  // 0x6a09e667f3bcc909

export function i64(val: bigint | number): bigint {
    return BigInt.asIntN(64, BigInt(val));
}

export function u64(val: bigint | number): bigint {
    return BigInt.asUintN(64, BigInt(val));
}

export function rotl64(x: bigint, k: number): bigint {
    const ux = BigInt.asUintN(64, x);
    const s = BigInt(k & 63);
    return BigInt.asIntN(64, ((ux << s) | (ux >> (64n - s))) & MASK_64);
}

export function mixStafford13(seed: bigint): bigint {
    let z = u64(seed);
    z = u64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = u64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return i64(z ^ (z >> 31n));
}

export function upgradeSeedTo128bit(seed: bigint): [bigint, bigint] {
    const loUnmixed = i64(seed ^ SILVER_RATIO_64);
    const hiUnmixed = i64(loUnmixed + GOLDEN_RATIO_64);
    return [mixStafford13(loUnmixed), mixStafford13(hiUnmixed)];
}

/**
 * Pure-JS RFC 1321 MD5 128-bit digest returning `[lo64, hi64]` in big-endian Java Long order,
 * matching `com.google.common.hash.Hashing.md5()` used by `XoroshiroRandomSource.PositionalRandomFactory`.
 */
export function md5As128BitSeed(str: string): [bigint, bigint] {
    const utf8 = new TextEncoder().encode(str);
    const bitLen = utf8.length * 8;
    const padLen = (((utf8.length + 8) >> 6) + 1) << 6;
    const buf = new Uint8Array(padLen);
    buf.set(utf8);
    buf[utf8.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, bitLen >>> 0, true);
    dv.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
    }

    for (let offset = 0; offset < padLen; offset += 64) {
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F = 0, g = 0;
            if (i < 16) {
                F = (B & C) | (~B & D);
                g = i;
            } else if (i < 32) {
                F = (D & B) | (~D & C);
                g = (5 * i + 1) & 15;
            } else if (i < 48) {
                F = B ^ C ^ D;
                g = (3 * i + 5) & 15;
            } else {
                F = C ^ (B | ~D);
                g = (7 * i) & 15;
            }
            const m = dv.getInt32(offset + g * 4, true);
            F = (F + A + K[i] + m) | 0;
            A = D;
            D = C;
            C = B;
            const s = S[i];
            B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
        }
        a0 = (a0 + A) | 0;
        b0 = (b0 + B) | 0;
        c0 = (c0 + C) | 0;
        d0 = (d0 + D) | 0;
    }

    const out = new ArrayBuffer(16);
    const outDv = new DataView(out);
    outDv.setInt32(0, a0, true);
    outDv.setInt32(4, b0, true);
    outDv.setInt32(8, c0, true);
    outDv.setInt32(12, d0, true);
    // Guava Longs.fromByteArray reads Big-Endian 64-bit longs from bytes 0..7 and 8..15
    return [outDv.getBigInt64(0, false), outDv.getBigInt64(8, false)];
}

/**
 * Authentic Minecraft `Xoroshiro128++` RandomSource (`net.minecraft.world.level.levelgen.XoroshiroRandomSource`)
 * Accelerated by `mc26_3_core.wasm` when initialized, with identical BigInt fallback in Worker threads.
 */
export class Xoroshiro128PlusPlus {
    public seedLo: bigint;
    public seedHi: bigint;
    private wasmOffset: number = -1;
    private gaussianNext: number | null = null;

    constructor(seedLo: bigint, seedHi?: bigint) {
        if (seedHi === undefined) {
            const [lo, hi] = upgradeSeedTo128bit(seedLo);
            this.seedLo = lo;
            this.seedHi = hi;
        } else {
            this.seedLo = i64(seedLo);
            this.seedHi = i64(seedHi);
            if ((this.seedLo | this.seedHi) === 0n) {
                this.seedLo = GOLDEN_RATIO_64;
                this.seedHi = SILVER_RATIO_64;
            }
        }
        if (JvmWasmCore.instance) {
            this.wasmOffset = JvmWasmCore.instance.allocPrngStateOffset();
            JvmWasmCore.instance.exports.xoroInit(this.wasmOffset, this.seedLo, this.seedHi);
        }
    }

    public nextLong(): bigint {
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextLong(this.wasmOffset);
        }
        const s0 = this.seedLo;
        let s1 = this.seedHi;
        const result = i64(rotl64(i64(s0 + s1), 17) + s0);
        s1 = i64(s1 ^ s0);
        this.seedLo = i64(rotl64(s0, 49) ^ s1 ^ i64(s1 << 21n));
        this.seedHi = rotl64(s1, 28);
        return result;
    }

    public nextInt(bound?: number): number {
        if (bound === undefined) {
            return Number(BigInt.asIntN(32, this.nextLong()));
        }
        if (bound <= 0) throw new Error('bound must be positive');
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextInt(this.wasmOffset, bound);
        }
        let r = u64(this.nextLong()) & 0xffffffffn;
        let m = r * BigInt(bound);
        let low = m & 0xffffffffn;
        if (low < BigInt(bound)) {
            const threshold = (0x100000000n - BigInt(bound)) % BigInt(bound);
            while (low < threshold) {
                r = u64(this.nextLong()) & 0xffffffffn;
                m = r * BigInt(bound);
                low = m & 0xffffffffn;
            }
        }
        return Number(m >> 32n);
    }

    public nextIntBetweenInclusive(min: number, max: number): number {
        return min + this.nextInt(max - min + 1);
    }

    public nextFloat(): number {
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextFloat(this.wasmOffset);
        }
        return Number(u64(this.nextLong()) >> 40n) * 5.960464477539063e-8;
    }

    public nextDouble(): number {
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextDouble(this.wasmOffset);
        }
        return Number(u64(this.nextLong()) >> 11n) * 1.1102230246251565e-16;
    }

    public nextBoolean(): boolean {
        return (this.nextLong() & 1n) !== 0n;
    }

    public nextGaussian(): number {
        if (this.gaussianNext !== null) {
            const g = this.gaussianNext;
            this.gaussianNext = null;
            return g;
        }
        let v1 = 0, v2 = 0, s = 0;
        do {
            v1 = 2 * this.nextDouble() - 1;
            v2 = 2 * this.nextDouble() - 1;
            s = v1 * v1 + v2 * v2;
        } while (s >= 1 || s === 0);
        const multiplier = Math.sqrt((-2 * Math.log(s)) / s);
        this.gaussianNext = v2 * multiplier;
        return v1 * multiplier;
    }

    public consumeCount(count: number): void {
        for (let i = 0; i < count; i++) this.nextLong();
    }

    public fork(): Xoroshiro128PlusPlus {
        return new Xoroshiro128PlusPlus(this.nextLong(), this.nextLong());
    }

    public forkPositional(): XoroshiroPositionalRandomFactory {
        return new XoroshiroPositionalRandomFactory(this.nextLong(), this.nextLong());
    }
}

export class XoroshiroPositionalRandomFactory {
    constructor(public readonly seedLo: bigint, public readonly seedHi: bigint) {}

    public at(x: number, y: number, z: number): Xoroshiro128PlusPlus {
        const posSeed = getBlockPosSeed(x, y, z);
        return new Xoroshiro128PlusPlus(posSeed ^ this.seedLo, this.seedHi);
    }

    public fromHashOf(name: string): Xoroshiro128PlusPlus {
        const clean = name.includes(':') ? name : `minecraft:${name}`;
        const [lo, hi] = md5As128BitSeed(clean);
        return new Xoroshiro128PlusPlus(lo ^ this.seedLo, hi ^ this.seedHi);
    }
}

/**
 * Exact `Mth.getSeed(int x, int y, int z)` 64-bit positional hash used by Minecraft block rendering and worldgen.
 */
export function getBlockPosSeed(x: number, y: number, z: number): bigint {
    let l = i64(BigInt(x * 3129871) ^ (BigInt(z) * 116129781n) ^ BigInt(y));
    l = i64(l * l * 42317861n + l * 11n);
    return l >> 16n;
}

/**
 * `net.minecraft.core.BlockPos` 64-bit bit-packed coordinate operations
 * Format: `((x & 0x3FFFFFF) << 38) | ((z & 0x3FFFFFF) << 12) | (y & 0xFFF)`
 */
export class BlockPos {
    public static asLong(x: number, y: number, z: number): bigint {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.packBlockPos(x | 0, y | 0, z | 0);
        }
        return (
            ((BigInt(x) & 0x3ffffffn) << 38n) |
            ((BigInt(z) & 0x3ffffffn) << 12n) |
            (BigInt(y) & 0xfffn)
        );
    }

    public static getX(packed: bigint): number {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosX(packed);
        }
        return Number(BigInt.asIntN(64, packed) >> 38n);
    }

    public static getY(packed: bigint): number {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosY(packed);
        }
        return Number(BigInt.asIntN(64, packed << 52n) >> 52n);
    }

    public static getZ(packed: bigint): number {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosZ(packed);
        }
        return Number(BigInt.asIntN(64, packed << 26n) >> 38n);
    }
}

export class ChunkPos {
    public static asLong(chunkX: number, chunkZ: number): bigint {
        return (BigInt(chunkX >>> 0) & 0xffffffffn) | ((BigInt(chunkZ >>> 0) & 0xffffffffn) << 32n);
    }

    public static getX(packed: bigint): number {
        return Number(BigInt.asIntN(32, packed & 0xffffffffn));
    }

    public static getZ(packed: bigint): number {
        return Number(BigInt.asIntN(32, packed >> 32n));
    }
}
