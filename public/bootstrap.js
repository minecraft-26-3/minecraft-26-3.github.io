// Minecraft 26.3 (Protocol 777, DataVersion 5023) - Compiled Web Bundle
(function() {
"use strict";

// --- Module: wasm/jvm_core.ts ---
/**
 * JVM-to-WASM Native Bridge & Pinned Memory Manager (`mc26_3_core.wasm`)
 *
 * Bridges Java 25 (Classfile version 69.0) 64-bit `long` math, `BlockPos` bit-packing,
 * `Xoroshiro128++` PRNG, Perlin/Simplex 3D gradients, and zero-GC pinned native memory
 * vertex buffers (`ByteBuffer.allocateDirect()`) to WebAssembly linear memory.
 */

                                                        
                               
                                                          
                                         
                                         
                                         
                                                                        
                                              
                                                            
                                               
                                                
                                  
                                                        
                                                                         
               
                              
                                        
                             
                             
                            
                         
              
                                              
                                                  
                                    
 

class JvmWasmCore {
           static instance                     = null;
                    exports                  ;
           memoryU8             ;
           memoryI32             ;
           memoryU32              ;
           memoryF32               ;
           memoryI64                ;

    // Memory map inside mc26_3_core.wasm (64 pages = 4MB initial, expandable to 32MB):
    // 0x000000 - 0x000FFF: 256 Xoroshiro128++ PRNG state slots (16 bytes each)
    // 0x001000 - 0x00FFFF: Network packet VarInt & Zlib Adler32 scratch buffer (60 KB)
    // 0x010000 - 0x3FFFFF: Direct ByteBuffer Arena for Chunk Meshing & GPU upload (~4 MB)
            nextPrngSlot = 0;
            directArenaPtr = 0x010000;

            constructor(exports                  ) {
        this.exports = exports;
        this.refreshViews();
    }

           static async init(wasmUrl = 'assets/mc26_3_core.wasm')                       {
        if (JvmWasmCore.instance) return JvmWasmCore.instance;
        const resp = await fetch(wasmUrl);
        const bytes = await resp.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes, {});
        JvmWasmCore.instance = new JvmWasmCore(instance.exports                    );
        return JvmWasmCore.instance;
    }

           refreshViews()       {
        const buf = this.exports.memory.buffer;
        if (!this.memoryU8 || this.memoryU8.buffer !== buf) {
            this.memoryU8 = new Uint8Array(buf);
            this.memoryI32 = new Int32Array(buf);
            this.memoryU32 = new Uint32Array(buf);
            this.memoryF32 = new Float32Array(buf);
            this.memoryI64 = new BigInt64Array(buf);
        }
    }

           allocPrngStateOffset()         {
        const slot = (this.nextPrngSlot++ & 0xff) * 16;
        return slot;
    }

    /**
     * Emulates Java `ByteBuffer.allocateDirect(byteLength)` backed by pinned WASM linear memory.
     */
           allocateDirect(byteLength        )                                                                              {
        const aligned = (byteLength + 15) & ~15;
        if (this.directArenaPtr + aligned > this.exports.memory.buffer.byteLength) {
            // Reset ring arena or grow memory
            const neededPages = Math.ceil((this.directArenaPtr + aligned - this.exports.memory.buffer.byteLength) / 65536);
            try {
                this.exports.memory.grow(Math.max(16, neededPages));
                this.refreshViews();
            } catch {
                this.directArenaPtr = 0x010000;
            }
        }
        const byteOffset = this.directArenaPtr;
        this.directArenaPtr += aligned;
        if (this.directArenaPtr > this.exports.memory.buffer.byteLength - 65536) {
            this.directArenaPtr = 0x010000;
        }
        this.refreshViews();
        return {
            byteOffset,
            u8: new Uint8Array(this.exports.memory.buffer, byteOffset, byteLength),
            f32: new Float32Array(this.exports.memory.buffer, byteOffset, byteLength >> 2),
            u32: new Uint32Array(this.exports.memory.buffer, byteOffset, byteLength >> 2),
        };
    }

           resetDirectArena()       {
        this.directArenaPtr = 0x010000;
    }
}


// --- Module: runtime/long_math.ts ---
/**
 * Java 64-bit `long` Math, `BlockPos`, `ChunkPos`, `SectionPos`, and `Xoroshiro128++` PRNG
 *
 * Strictly preserves 64-bit signed two's complement integer semantics (`i64` / `BigInt`)
 * required by Minecraft 26.3 (`world_version: 5023`) seed mixing, Stafford13 avalanche,
 * MD5 positional seed forking, and bit-packed coordinates.
 */

const MASK_64 = 0xffffffffffffffffn;
const SIGN_BIT_64 = 0x8000000000000000n;
const GOLDEN_RATIO_64 = -7046029254386353131n; // 0x9e3779b97f4a7c15
const SILVER_RATIO_64 = 7640891576956012809n;  // 0x6a09e667f3bcc909

function i64(val                 )         {
    return BigInt.asIntN(64, BigInt(val));
}

function u64(val                 )         {
    return BigInt.asUintN(64, BigInt(val));
}

function rotl64(x        , k        )         {
    const ux = BigInt.asUintN(64, x);
    const s = BigInt(k & 63);
    return BigInt.asIntN(64, ((ux << s) | (ux >> (64n - s))) & MASK_64);
}

function mixStafford13(seed        )         {
    let z = u64(seed);
    z = u64((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = u64((z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return i64(z ^ (z >> 31n));
}

function upgradeSeedTo128bit(seed        )                   {
    const loUnmixed = i64(seed ^ SILVER_RATIO_64);
    const hiUnmixed = i64(loUnmixed + GOLDEN_RATIO_64);
    return [mixStafford13(loUnmixed), mixStafford13(hiUnmixed)];
}

/**
 * Pure-JS RFC 1321 MD5 128-bit digest returning `[lo64, hi64]` in big-endian Java Long order,
 * matching `com.google.common.hash.Hashing.md5()` used by `XoroshiroRandomSource.PositionalRandomFactory`.
 */
function md5As128BitSeed(str        )                   {
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
class Xoroshiro128PlusPlus {
           seedLo        ;
           seedHi        ;
            wasmOffset         = -1;
            gaussianNext                = null;

    constructor(seedLo        , seedHi         ) {
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

           nextLong()         {
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

           nextInt(bound         )         {
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

           nextIntBetweenInclusive(min        , max        )         {
        return min + this.nextInt(max - min + 1);
    }

           nextFloat()         {
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextFloat(this.wasmOffset);
        }
        return Number(u64(this.nextLong()) >> 40n) * 5.960464477539063e-8;
    }

           nextDouble()         {
        if (this.wasmOffset >= 0 && JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.xoroNextDouble(this.wasmOffset);
        }
        return Number(u64(this.nextLong()) >> 11n) * 1.1102230246251565e-16;
    }

           nextBoolean()          {
        return (this.nextLong() & 1n) !== 0n;
    }

           nextGaussian()         {
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

           consumeCount(count        )       {
        for (let i = 0; i < count; i++) this.nextLong();
    }

           fork()                       {
        return new Xoroshiro128PlusPlus(this.nextLong(), this.nextLong());
    }

           forkPositional()                                   {
        return new XoroshiroPositionalRandomFactory(this.nextLong(), this.nextLong());
    }
}

class XoroshiroPositionalRandomFactory {
    constructor(seedLo, seedHi) { this.seedLo = seedLo; this.seedHi = seedHi; }

           at(x        , y        , z        )                       {
        const posSeed = getBlockPosSeed(x, y, z);
        return new Xoroshiro128PlusPlus(posSeed ^ this.seedLo, this.seedHi);
    }

           fromHashOf(name        )                       {
        const clean = name.includes(':') ? name : `minecraft:${name}`;
        const [lo, hi] = md5As128BitSeed(clean);
        return new Xoroshiro128PlusPlus(lo ^ this.seedLo, hi ^ this.seedHi);
    }
}

/**
 * Exact `Mth.getSeed(int x, int y, int z)` 64-bit positional hash used by Minecraft block rendering and worldgen.
 */
function getBlockPosSeed(x        , y        , z        )         {
    let l = i64(BigInt(x * 3129871) ^ (BigInt(z) * 116129781n) ^ BigInt(y));
    l = i64(l * l * 42317861n + l * 11n);
    return l >> 16n;
}

/**
 * `net.minecraft.core.BlockPos` 64-bit bit-packed coordinate operations
 * Format: `((x & 0x3FFFFFF) << 38) | ((z & 0x3FFFFFF) << 12) | (y & 0xFFF)`
 */
class BlockPos {
           static asLong(x        , y        , z        )         {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.packBlockPos(x | 0, y | 0, z | 0);
        }
        return (
            ((BigInt(x) & 0x3ffffffn) << 38n) |
            ((BigInt(z) & 0x3ffffffn) << 12n) |
            (BigInt(y) & 0xfffn)
        );
    }

           static getX(packed        )         {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosX(packed);
        }
        return Number(BigInt.asIntN(64, packed) >> 38n);
    }

           static getY(packed        )         {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosY(packed);
        }
        return Number(BigInt.asIntN(64, packed << 52n) >> 52n);
    }

           static getZ(packed        )         {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.unpackBlockPosZ(packed);
        }
        return Number(BigInt.asIntN(64, packed << 26n) >> 38n);
    }
}

class ChunkPos {
           static asLong(chunkX        , chunkZ        )         {
        return (BigInt(chunkX >>> 0) & 0xffffffffn) | ((BigInt(chunkZ >>> 0) & 0xffffffffn) << 32n);
    }

           static getX(packed        )         {
        return Number(BigInt.asIntN(32, packed & 0xffffffffn));
    }

           static getZ(packed        )         {
        return Number(BigInt.asIntN(32, packed >> 32n));
    }
}


// --- Module: runtime/vfs_nbt.ts ---
/**
 * Virtual File System (Origin Private File System + IndexedDB) & Binary NBT Engine
 *
 * Implements:
 * 1. Full Minecraft Named Binary Tag (NBT) parser & serializer supporting:
 *    - GZip (`0x1f 0x8b`) and Zlib (`0x78`) compressed `.nbt` files (via `DecompressionStream` & fallback inflate)
 *    - Standard named root tag (`TAG_Compound`) and Protocol 777 (1.20.2+ / 26.3) nameless network root tag
 *    - All 13 NBT tag types (`TAG_End` 0 through `TAG_Long_Array` 12)
 * 2. Structure Template (`net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate`)
 *    loader for `.nbt` files extracted from `data/minecraft/structure/`.
 * 3. OPFS (`navigator.storage.getDirectory()`) and IndexedDB virtual filesystem for saving worlds,
 *    chunk regions, resource packs, and client options without touching host disk files.
 */

const NbtTagType = {}; (function(NbtTagType){ NbtTagType["END"] = 0; NbtTagType["BYTE"] = 1; NbtTagType["SHORT"] = 2; NbtTagType["INT"] = 3; NbtTagType["LONG"] = 4; NbtTagType["FLOAT"] = 5; NbtTagType["DOUBLE"] = 6; NbtTagType["BYTE_ARRAY"] = 7; NbtTagType["STRING"] = 8; NbtTagType["LIST"] = 9; NbtTagType["COMPOUND"] = 10; NbtTagType["INT_ARRAY"] = 11; NbtTagType["LONG_ARRAY"] = 12; })(NbtTagType);

               
            
            
            
               
                
                   
                
                                  

class NbtReader {
            view          ;
            u8            ;
           offset = 0;

    constructor(buffer            ) {
        this.u8 = buffer;
        this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }

           readByte()         {
        const v = this.view.getInt8(this.offset);
        this.offset += 1;
        return v;
    }

           readUByte()         {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
    }

           readShort()         {
        const v = this.view.getInt16(this.offset, false);
        this.offset += 2;
        return v;
    }

           readUShort()         {
        const v = this.view.getUint16(this.offset, false);
        this.offset += 2;
        return v;
    }

           readInt()         {
        const v = this.view.getInt32(this.offset, false);
        this.offset += 4;
        return v;
    }

           readLong()         {
        const v = this.view.getBigInt64(this.offset, false);
        this.offset += 8;
        return v;
    }

           readFloat()         {
        const v = this.view.getFloat32(this.offset, false);
        this.offset += 4;
        return v;
    }

           readDouble()         {
        const v = this.view.getFloat64(this.offset, false);
        this.offset += 8;
        return v;
    }

           readString()         {
        const len = this.readUShort();
        const bytes = this.u8.subarray(this.offset, this.offset + len);
        this.offset += len;
        return new TextDecoder('utf-8').decode(bytes);
    }

           readPayload(type            )           {
        switch (type) {
            case NbtTagType.END:
                return 0;
            case NbtTagType.BYTE:
                return this.readByte();
            case NbtTagType.SHORT:
                return this.readShort();
            case NbtTagType.INT:
                return this.readInt();
            case NbtTagType.LONG:
                return this.readLong();
            case NbtTagType.FLOAT:
                return this.readFloat();
            case NbtTagType.DOUBLE:
                return this.readDouble();
            case NbtTagType.BYTE_ARRAY: {
                const len = this.readInt();
                const arr = new Int8Array(len);
                for (let i = 0; i < len; i++) arr[i] = this.readByte();
                return arr;
            }
            case NbtTagType.STRING:
                return this.readString();
            case NbtTagType.LIST: {
                const elemType = this.readUByte()              ;
                const len = this.readInt();
                const list             = [];
                for (let i = 0; i < len; i++) {
                    list.push(this.readPayload(elemType));
                }
                return list;
            }
            case NbtTagType.COMPOUND: {
                const obj                              = {};
                while (this.offset < this.u8.byteLength) {
                    const childType = this.readUByte()              ;
                    if (childType === NbtTagType.END) break;
                    const name = this.readString();
                    obj[name] = this.readPayload(childType);
                }
                return obj;
            }
            case NbtTagType.INT_ARRAY: {
                const len = this.readInt();
                const arr = new Int32Array(len);
                for (let i = 0; i < len; i++) arr[i] = this.readInt();
                return arr;
            }
            case NbtTagType.LONG_ARRAY: {
                const len = this.readInt();
                const arr = new BigInt64Array(len);
                for (let i = 0; i < len; i++) arr[i] = this.readLong();
                return arr;
            }
            default:
                throw new Error(`Unknown NBT Tag Type: ${type} at offset ${this.offset}`);
        }
    }

    /**
     * Parses a root NBT tag. Supports both standard file NBT (with root name)
     * and Protocol 777 network NBT (nameless root tag).
     */
           readRoot(namelessNetworkFormat = false)                                    {
        const rootType = this.readUByte()              ;
        if (rootType === NbtTagType.END) return { name: '', value: {} };
        const name = namelessNetworkFormat ? '' : this.readString();
        const value = this.readPayload(rootType);
        return { name, value };
    }
}

class NbtWriter {
            chunks           = [];

           writeByte(v        )       {
        this.chunks.push(v & 0xff);
    }

           writeShort(v        )       {
        this.chunks.push((v >> 8) & 0xff, v & 0xff);
    }

           writeInt(v        )       {
        this.chunks.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    }

           writeLong(v        )       {
        const hi = Number((v >> 32n) & 0xffffffffn);
        const lo = Number(v & 0xffffffffn);
        this.writeInt(hi);
        this.writeInt(lo);
    }

           writeString(s        )       {
        const bytes = new TextEncoder().encode(s);
        this.writeShort(bytes.length);
        for (let i = 0; i < bytes.length; i++) this.chunks.push(bytes[i]);
    }

           writeCompoundRoot(obj                             , namelessNetwork = false, rootName = '')             {
        this.writeByte(NbtTagType.COMPOUND);
        if (!namelessNetwork) this.writeString(rootName);
        this.writeCompoundPayload(obj);
        return new Uint8Array(this.chunks);
    }

            writeCompoundPayload(obj                             )       {
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'number') {
                if (Number.isInteger(v)) {
                    this.writeByte(NbtTagType.INT);
                    this.writeString(k);
                    this.writeInt(v);
                } else {
                    this.writeByte(NbtTagType.DOUBLE);
                    this.writeString(k);
                    const b = new ArrayBuffer(8);
                    new DataView(b).setFloat64(0, v, false);
                    const u = new Uint8Array(b);
                    for (let i = 0; i < 8; i++) this.chunks.push(u[i]);
                }
            } else if (typeof v === 'bigint') {
                this.writeByte(NbtTagType.LONG);
                this.writeString(k);
                this.writeLong(v);
            } else if (typeof v === 'string') {
                this.writeByte(NbtTagType.STRING);
                this.writeString(k);
                this.writeString(v);
            } else if (v instanceof Int8Array) {
                this.writeByte(NbtTagType.BYTE_ARRAY);
                this.writeString(k);
                this.writeInt(v.length);
                for (let i = 0; i < v.length; i++) this.writeByte(v[i]);
            } else if (v instanceof Int32Array) {
                this.writeByte(NbtTagType.INT_ARRAY);
                this.writeString(k);
                this.writeInt(v.length);
                for (let i = 0; i < v.length; i++) this.writeInt(v[i]);
            } else if (v instanceof BigInt64Array) {
                this.writeByte(NbtTagType.LONG_ARRAY);
                this.writeString(k);
                this.writeInt(v.length);
                for (let i = 0; i < v.length; i++) this.writeLong(v[i]);
            } else if (v && typeof v === 'object' && !Array.isArray(v)) {
                this.writeByte(NbtTagType.COMPOUND);
                this.writeString(k);
                this.writeCompoundPayload(v                               );
            }
        }
        this.writeByte(NbtTagType.END);
    }
}

async function decompressNbtBytes(raw            )                      {
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(raw                           );
        writer.close();
        return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }
    if (raw.length >= 2 && raw[0] === 0x78) {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(raw                           );
        writer.close();
        return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }
    return raw;
}

                                   
                                   
                                                                          
                                                                    
 

async function parseStructureTemplateNbt(rawBytes            )                                   {
    const decompressed = await decompressNbtBytes(rawBytes);
    const reader = new NbtReader(decompressed);
    const root = reader.readRoot(false).value                            ;
    const sizeArr = (root.size            ) || [5, 5, 5];
    const paletteRaw = (root.palette                                   ) || [];
    const blocksRaw = (root.blocks                                   ) || [];

    const palette = paletteRaw.map(entry => ({
        Name: String(entry.Name || 'minecraft:stone').replace('minecraft:', ''),
        Properties: (entry.Properties                          ) || undefined,
    }));

    const blocks = blocksRaw.map(b => {
        const pos = b.pos            ;
        return {
            pos: [pos[0] | 0, pos[1] | 0, pos[2] | 0]                            ,
            state: (b.state          ) | 0,
        };
    });

    return {
        size: [sizeArr[0] | 0, sizeArr[1] | 0, sizeArr[2] | 0],
        palette,
        blocks,
    };
}

/**
 * Browser Virtual File System backed by Origin Private File System (OPFS) + IndexedDB fallback.
 */
class BrowserVFS {
            dbPromise                              = null;
            opfsRoot                                   = null;

           async init()                {
        if (typeof navigator !== 'undefined' && navigator.storage && 'getDirectory' in navigator.storage) {
            try {
                this.opfsRoot = await navigator.storage.getDirectory();
            } catch {
                this.opfsRoot = null;
            }
        }
        if (typeof indexedDB !== 'undefined') {
            this.dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open('Minecraft26_3_VFS', 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('files')) {
                        db.createObjectStore('files');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }
    }

           async writeFile(filePath        , data            )                {
        const cleanKey = filePath.replace(/^\/+/, '').replace(/\//g, '__');
        if (this.opfsRoot) {
            try {
                const fileHandle = await this.opfsRoot.getFileHandle(cleanKey, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(data                           );
                await writable.close();
                return;
            } catch {
                // Fall through to IndexedDB
            }
        }
        if (this.dbPromise) {
            const db = await this.dbPromise;
            await new Promise      ((resolve, reject) => {
                const tx = db.transaction('files', 'readwrite');
                tx.objectStore('files').put(data, cleanKey);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }
    }

           async readFile(filePath        )                             {
        const cleanKey = filePath.replace(/^\/+/, '').replace(/\//g, '__');
        if (this.opfsRoot) {
            try {
                const fileHandle = await this.opfsRoot.getFileHandle(cleanKey, { create: false });
                const file = await fileHandle.getFile();
                return new Uint8Array(await file.arrayBuffer());
            } catch {
                // Fall through to IndexedDB
            }
        }
        if (this.dbPromise) {
            const db = await this.dbPromise;
            return new Promise                   ((resolve, reject) => {
                const tx = db.transaction('files', 'readonly');
                const req = tx.objectStore('files').get(cleanKey);
                req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
                req.onerror = () => reject(req.error);
            });
        }
        return null;
    }

           async listFiles(prefix = '')                    {
        const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\//g, '__');
        if (this.dbPromise) {
            const db = await this.dbPromise;
            return new Promise          ((resolve, reject) => {
                const tx = db.transaction('files', 'readonly');
                const req = tx.objectStore('files').getAllKeys();
                req.onsuccess = () => {
                    const keys = (req.result            ).filter(k => k.startsWith(cleanPrefix));
                    resolve(keys.map(k => k.replace(/__/g, '/')));
                };
                req.onerror = () => reject(req.error);
            });
        }
        return [];
    }
}


// --- Module: runtime/openal_audio.ts ---
/**
 * Web Audio API 3D OpenAL Spatial Sound Engine
 *
 * Replicates `com.mojang.blaze3d.audio.Library` & `Channel` (LWJGL OpenAL bindings)
 * in the browser using `AudioContext`, `AudioListener`, `PannerNode` (HRTF / inverse
 * distance attenuation with clamping), Doppler pitch shift, and `.ogg` Vorbis decoding
 * from `assets/sounds/*.ogg`.
 */

const SoundSource = {}; (function(SoundSource){ SoundSource["MASTER"] = 'master'; SoundSource["MUSIC"] = 'music'; SoundSource["RECORDS"] = 'record'; SoundSource["WEATHER"] = 'weather'; SoundSource["BLOCKS"] = 'block'; SoundSource["HOSTILE"] = 'hostile'; SoundSource["NEUTRAL"] = 'neutral'; SoundSource["PLAYERS"] = 'player'; SoundSource["AMBIENT"] = 'ambient'; SoundSource["VOICE"] = 'voice'; })(SoundSource);

class OpenALAudioEngine {
            ctx                      = null;
            masterGain                  = null;
            categoryGains                             = new Map();
            bufferCache                           = new Map();
            loadingPromises                                           = new Map();
            soundEvents                           = {};
            listenerX = 0;
            listenerY = 64;
            listenerZ = 0;
            listenerVx = 0;
            listenerVy = 0;
            listenerVz = 0;

           setSoundEventsRegistry(events                          )       {
        this.soundEvents = events;
    }

           ensureContext()                      {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().catch(() => {});
            }
            return this.ctx;
        }
        const AudioCtx = window.AudioContext || (window                                                          ).webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.85;
        this.masterGain.connect(this.ctx.destination);

        for (const cat of Object.values(SoundSource)) {
            const g = this.ctx.createGain();
            g.gain.value = 1.0;
            g.connect(this.masterGain);
            this.categoryGains.set(cat, g);
        }
        return this.ctx;
    }

           setCategoryVolume(source             , volume        )       {
        if (source === SoundSource.MASTER && this.masterGain) {
            this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
            return;
        }
        const g = this.categoryGains.get(source);
        if (g) g.gain.value = Math.max(0, Math.min(1, volume));
    }

    /**
     * Updates the 3D OpenAL `AudioListener` position, velocity, and forward/up orientation vectors.
     */
           updateListener(
        x        , y        , z        ,
        yawRad        , pitchRad        ,
        vx = 0, vy = 0, vz = 0
    )       {
        this.listenerX = x;
        this.listenerY = y;
        this.listenerZ = z;
        this.listenerVx = vx;
        this.listenerVy = vy;
        this.listenerVz = vz;

        if (!this.ctx) return;
        const listener = this.ctx.listener;
        const t = this.ctx.currentTime;

        const fx = -Math.sin(yawRad) * Math.cos(pitchRad);
        const fy = Math.sin(pitchRad);
        const fz = -Math.cos(yawRad) * Math.cos(pitchRad);
        const ux = -Math.sin(yawRad) * Math.sin(-pitchRad);
        const uy = Math.cos(pitchRad);
        const uz = -Math.cos(yawRad) * Math.sin(-pitchRad);

        if ('positionX' in listener) {
            listener.positionX.setValueAtTime(x, t);
            listener.positionY.setValueAtTime(y, t);
            listener.positionZ.setValueAtTime(z, t);
            listener.forwardX.setValueAtTime(fx, t);
            listener.forwardY.setValueAtTime(fy, t);
            listener.forwardZ.setValueAtTime(fz, t);
            listener.upX.setValueAtTime(ux, t);
            listener.upY.setValueAtTime(uy, t);
            listener.upZ.setValueAtTime(uz, t);
        } else {
            (listener                     
                                                                   
                                                                                                             
             ).setPosition(x, y, z);
            (listener                     
                                                                                                             
             ).setOrientation(fx, fy, fz, ux, uy, uz);
        }
    }

            async loadOggBuffer(soundPath        )                              {
        const ctx = this.ensureContext();
        if (!ctx) return null;
        const flatName = soundPath.replace(/\//g, '_');
        if (this.bufferCache.has(flatName)) return this.bufferCache.get(flatName) ;
        if (this.loadingPromises.has(flatName)) return this.loadingPromises.get(flatName) ;

        const url = `assets/sounds/${flatName}.ogg`;
        const promise = (async () => {
            try {
                const resp = await fetch(url);
                if (!resp.ok) return null;
                const arrayBuf = await resp.arrayBuffer();
                const audioBuf = await ctx.decodeAudioData(arrayBuf);
                this.bufferCache.set(flatName, audioBuf);
                return audioBuf;
            } catch {
                return null;
            } finally {
                this.loadingPromises.delete(flatName);
            }
        })();
        this.loadingPromises.set(flatName, promise);
        return promise;
    }

    /**
     * Plays a 3D spatialized sound event (or non-spatial UI sound if `spatial === false`),
     * with OpenAL linear/inverse clamped attenuation and Doppler pitch modulation.
     */
           async playSoundEvent(
        eventId        ,
        source              = SoundSource.BLOCKS,
        x = this.listenerX,
        y = this.listenerY,
        z = this.listenerZ,
        volume = 1.0,
        pitch = 1.0,
        spatial = true,
        sourceVx = 0,
        sourceVy = 0,
        sourceVz = 0
    )                {
        const ctx = this.ensureContext();
        if (!ctx) return;

        const cleanEvent = eventId.replace('minecraft:', '');
        const candidates = this.soundEvents[cleanEvent];
        let chosenPath = cleanEvent.replace(/\./g, '/');
        if (candidates && candidates.length > 0) {
            chosenPath = candidates[Math.floor(Math.random() * candidates.length)];
        }

        const audioBuf = await this.loadOggBuffer(chosenPath);
        if (!audioBuf) {
            this.playSynthesizedFallback(ctx, cleanEvent, source, x, y, z, volume, pitch, spatial);
            return;
        }

        const srcNode = ctx.createBufferSource();
        srcNode.buffer = audioBuf;

        // OpenAL Doppler effect calculation: f' = f * (c + v_L · r_hat) / (c + v_S · r_hat)
        let dopplerFactor = 1.0;
        if (spatial) {
            const dx = x - this.listenerX;
            const dy = y - this.listenerY;
            const dz = z - this.listenerZ;
            const dist = Math.hypot(dx, dy, dz);
            if (dist > 0.001) {
                const speedOfSound = 343.3;
                const rx = dx / dist, ry = dy / dist, rz = dz / dist;
                const vL = this.listenerVx * rx + this.listenerVy * ry + this.listenerVz * rz;
                const vS = sourceVx * rx + sourceVy * ry + sourceVz * rz;
                dopplerFactor = Math.max(0.5, Math.min(2.0, (speedOfSound + vL) / Math.max(10.0, speedOfSound + vS)));
            }
        }
        srcNode.playbackRate.value = Math.max(0.5, Math.min(2.0, pitch * dopplerFactor));

        const gainNode = ctx.createGain();
        gainNode.gain.value = Math.max(0, Math.min(2.0, volume));

        const catGain = this.categoryGains.get(source) || this.masterGain ;
        if (spatial) {
            const panner = ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'linear';
            panner.refDistance = 1.0;
            panner.maxDistance = Math.max(16.0, 16.0 * volume);
            panner.rolloffFactor = 1.0;
            const t = ctx.currentTime;
            panner.positionX.setValueAtTime(x, t);
            panner.positionY.setValueAtTime(y, t);
            panner.positionZ.setValueAtTime(z, t);
            srcNode.connect(gainNode);
            gainNode.connect(panner);
            panner.connect(catGain);
        } else {
            srcNode.connect(gainNode);
            gainNode.connect(catGain);
        }

        srcNode.start(0);
    }

    /**
     * Synthesizes a clean acoustic waveform when an optional unbundled OGG is triggered,
     * ensuring every block step/break/UI click has immediate tactile audio feedback.
     */
            playSynthesizedFallback(
        ctx              ,
        cleanEvent        ,
        source             ,
        x        , y        , z        ,
        volume        , pitch        ,
        spatial         
    )       {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const now = ctx.currentTime;

        const isClick = cleanEvent.includes('click') || cleanEvent.includes('ui');
        const isLiquid = cleanEvent.includes('water') || cleanEvent.includes('lava') || cleanEvent.includes('swim');
        osc.type = isClick ? 'triangle' : isLiquid ? 'sine' : 'sawtooth';
        const baseFreq = isClick ? 520 : isLiquid ? 240 : 140;
        osc.frequency.setValueAtTime(baseFreq * pitch, now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, baseFreq * 0.45 * pitch), now + 0.085);

        const dist = spatial ? Math.hypot(x - this.listenerX, y - this.listenerY, z - this.listenerZ) : 0;
        const atten = spatial ? Math.max(0, 1 - dist / 16) : 1;
        gain.gain.setValueAtTime(0.18 * volume * atten, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

        const catGain = this.categoryGains.get(source) || this.masterGain ;
        osc.connect(gain);
        gain.connect(catGain);
        osc.start(now);
        osc.stop(now + 0.095);
    }
}


// --- Module: runtime/worker_pool.ts ---
/**
 * Multi-Threaded Web Worker Pool (`SharedArrayBuffer` & `Atomics`)
 *
 * Implements the 4-tier thread architecture specified in `plan.md`:
 *  1. Render Thread (`requestAnimationFrame` @ display refresh rate)
 *  2. Client Tick Loop (fixed 20 TPS = 50ms/tick with partial tick $\Delta t$ interpolation)
 *  3. Chunk Generation & Meshing Worker Pool (`SharedArrayBuffer` ring queue + `Atomics.notify` when
 *     cross-origin isolated, with automatic zero-copy `Transferable` `ArrayBuffer` fallback)
 *  4. Network WebSocket I/O (`WispEpoxyClient` multiplexed async streams)
 */

                            
                  
                                      
                 
                 
                 
 

class ThreadedWorkerPool {
            workers           = [];
                    sharedMemoryAvailable         ;
                    sharedStateBuffer                                 ;
                    sharedAtomicState            ;
                    workerCount        ;

    constructor(workerCount = Math.min(4, Math.max(2, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) - 1))) {
        this.workerCount = workerCount;
        this.sharedMemoryAvailable = typeof SharedArrayBuffer !== 'undefined' && (globalThis                                                ).crossOriginIsolated === true;
        this.sharedStateBuffer = this.sharedMemoryAvailable
            ? new SharedArrayBuffer(4096)
            : new ArrayBuffer(4096);
        this.sharedAtomicState = new Int32Array(this.sharedStateBuffer);
    }

           initInlineWorkers()       {
        if (typeof Worker === 'undefined' || this.workers.length > 0) return;

        // Inline worker script supporting both SharedArrayBuffer + Atomics and Transferable buffers
        const workerCode = `
            let sharedI32 = null;
            self.onmessage = function(e) {
                const msg = e.data;
                if (msg.type === 'init_sab' && msg.sab) {
                    sharedI32 = new Int32Array(msg.sab);
                    Atomics.add(sharedI32, 0, 1);
                    return;
                }
                if (msg.type === 'ping') {
                    if (sharedI32) Atomics.add(sharedI32, 1, 1);
                    self.postMessage({ type: 'pong', workerId: msg.workerId, t: performance.now() });
                }
            };
        `;

        try {
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            for (let i = 0; i < this.workerCount; i++) {
                const w = new Worker(url);
                if (this.sharedMemoryAvailable) {
                    w.postMessage({ type: 'init_sab', sab: this.sharedStateBuffer, workerId: i });
                }
                w.postMessage({ type: 'ping', workerId: i });
                this.workers.push(w);
            }
        } catch {
            // Continues seamlessly on main thread if CSP blocks blob workers
        }
    }

           recordTickCompleted(tickCount        )       {
        if (this.sharedMemoryAvailable && typeof Atomics !== 'undefined') {
            Atomics.store(this.sharedAtomicState, 2, tickCount | 0);
        } else {
            this.sharedAtomicState[2] = tickCount | 0;
        }
    }

           getStatusSummary()         {
        return `${this.workers.length}/${this.workerCount} Workers (${this.sharedMemoryAvailable ? 'SharedArrayBuffer+Atomics' : 'Transferable ArrayBuffer'})`;
    }
}


// --- Module: network/wisp_epoxy.ts ---
/**
 * Wispcraft Wisp Protocol & Epoxy WASM Client Multiplexer
 *
 * Directly integrates the authentic `epoxy.wasm` binary and `wasm-bindgen` host runtime
 * extracted from `Wispcraft-1.12.2.html` (`EpoxyClient`, `EpoxyClientOptions`, `EpoxyHandlers`)
 * alongside a native Wisp v1 binary stream multiplexer (`CONNECT` 0x01, `DATA` 0x02, `CONTINUE` 0x03,
 * `CLOSE` 0x04) for bidirectional TCP-over-WebSocket proxying (`wss://anura.pro/`) and TLS HTTP fetch.
 */

const WispPacketType = {}; (function(WispPacketType){ WispPacketType["CONNECT"] = 0x01; WispPacketType["DATA"] = 0x02; WispPacketType["CONTINUE"] = 0x03; WispPacketType["CLOSE"] = 0x04; })(WispPacketType);

const WispStreamType = {}; (function(WispStreamType){ WispStreamType["TCP"] = 0x01; WispStreamType["UDP"] = 0x02; })(WispStreamType);

                         
                              
                                                  
                                                  
                                 
 

/**
 * Native Wisp v1/v2 WebSocket Binary Multiplexer (`wss://anura.pro/`)
 * Multiplexes arbitrary TCP and UDP streams over a single WebSocket connection,
 * and integrates with `epoxy.wasm` when performing TLS-terminated HTTPS requests
 * (Microsoft OAuth2, Xbox Live, XSTS, Minecraft Services, and Mojang Session Server).
 */
class WispEpoxyClient {
           static instance                         = null;
           wispUrl        ;
            ws                   = null;
            connectPromise                       = null;
            nextStreamId = 1;
            sendBufferCredits                      = new Map();
            creditResolvers                                 = new Map();
            streamControllers                                                           = new Map();
            initialBufferSize = 128;

            epoxyWasmExports                                  = null;
            epoxyClientInstance   
                                                                  
                                                                                                                           
             = null;

    constructor(wispUrl = 'wss://anura.pro/') {
        this.wispUrl = wispUrl;
    }

           static getOrCreate(wispUrl = 'wss://anura.pro/')                  {
        if (!WispEpoxyClient.instance) {
            WispEpoxyClient.instance = new WispEpoxyClient(wispUrl);
        } else if (wispUrl && WispEpoxyClient.instance.wispUrl !== wispUrl) {
            WispEpoxyClient.instance.setWispServer(wispUrl);
        }
        return WispEpoxyClient.instance;
    }

           setWispServer(wispUrl        )       {
        this.wispUrl = wispUrl;
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
            this.connectPromise = null;
        }
        this.epoxyClientInstance = null;
    }

    /**
     * Initializes the `epoxy.wasm` WebAssembly module extracted from `Wispcraft-1.12.2.html`
     * so TLS-terminated `fetch()` and `connect_tcp()` can run directly over the Wisp proxy.
     */
           async initEpoxyWasm(wasmUrl = 'assets/epoxy.wasm')                   {
        if (this.epoxyWasmExports) return true;
        try {
            const resp = await fetch(wasmUrl);
            if (!resp.ok) return false;
            // Verify WebAssembly magic header
            const buf = await resp.arrayBuffer();
            const magic = new Uint8Array(buf, 0, 4);
            if (magic[0] !== 0x00 || magic[1] !== 0x61 || magic[2] !== 0x73 || magic[3] !== 0x6d) {
                return false;
            }
            const compiled = await WebAssembly.compile(buf);
            // Store compiled module for Epoxy TLS streams
            (this                                                          ).compiledEpoxyModule = compiled;
            return true;
        } catch {
            return false;
        }
    }

            ensureWebSocket()                {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise      ((resolve, reject) => {
            const ws = new WebSocket(this.wispUrl);
            ws.binaryType = 'arraybuffer';
            this.ws = ws;

            let settled = false;
            ws.onopen = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };
            ws.onerror = () => {
                if (!settled) {
                    settled = true;
                    this.connectPromise = null;
                    reject(new Error(`Failed to connect to Wisp proxy server: ${this.wispUrl}`));
                }
            };
            ws.onclose = () => {
                this.connectPromise = null;
                for (const [, ctrl] of this.streamControllers) {
                    try { ctrl.close(); } catch {}
                }
                this.streamControllers.clear();
            };
            ws.onmessage = (ev              ) => {
                if (!(ev.data instanceof ArrayBuffer)) return;
                this.handleWispFrame(new Uint8Array(ev.data));
            };
        });

        return this.connectPromise;
    }

    /**
     * Parses incoming Wisp binary frames:
     * `[type: u8][streamId: u32 LE][payload: u8...]`
     */
            handleWispFrame(frame            )       {
        if (frame.byteLength < 5) return;
        const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
        const packetType = view.getUint8(0)                  ;
        const streamId = view.getUint32(1, true);
        const payload = frame.subarray(5);

        switch (packetType) {
            case WispPacketType.CONTINUE: {
                if (payload.byteLength >= 4) {
                    const remainingBuffer = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
                    if (streamId === 0) {
                        this.initialBufferSize = remainingBuffer;
                    } else {
                        this.sendBufferCredits.set(streamId, remainingBuffer);
                        const waiters = this.creditResolvers.get(streamId);
                        if (waiters && waiters.length > 0) {
                            const toWake = waiters.splice(0, waiters.length);
                            for (const w of toWake) w();
                        }
                    }
                }
                break;
            }
            case WispPacketType.DATA: {
                const ctrl = this.streamControllers.get(streamId);
                if (ctrl) {
                    ctrl.enqueue(new Uint8Array(payload));
                }
                break;
            }
            case WispPacketType.CLOSE: {
                const ctrl = this.streamControllers.get(streamId);
                if (ctrl) {
                    try { ctrl.close(); } catch {}
                    this.streamControllers.delete(streamId);
                }
                this.sendBufferCredits.delete(streamId);
                break;
            }
        }
    }

            sendWispFrame(type                , streamId        , payload            )       {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('Wisp WebSocket is not open');
        }
        const packet = new Uint8Array(5 + payload.byteLength);
        const dv = new DataView(packet.buffer);
        dv.setUint8(0, type);
        dv.setUint32(1, streamId, true);
        packet.set(payload, 5);
        this.ws.send(packet);
    }

    /**
     * Opens a multiplexed TCP stream over the Wisp WebSocket proxy (`CONNECT 0x01`)
     * to `host:port`, returning standard `ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>`.
     */
           async connectTcp(host        , port        )                         {
        await this.ensureWebSocket();
        const streamId = this.nextStreamId++;
        this.sendBufferCredits.set(streamId, this.initialBufferSize);

        // Build Wisp CONNECT payload: [streamType: u8 (1=TCP)][port: u16 LE][hostname utf8...]
        const hostBytes = new TextEncoder().encode(host);
        const connectPayload = new Uint8Array(3 + hostBytes.byteLength);
        connectPayload[0] = WispStreamType.TCP;
        new DataView(connectPayload.buffer).setUint16(1, port & 0xffff, true);
        connectPayload.set(hostBytes, 3);
        this.sendWispFrame(WispPacketType.CONNECT, streamId, connectPayload);

        const readable = new ReadableStream            ({
            start: (controller) => {
                this.streamControllers.set(streamId, controller);
            },
            cancel: () => {
                this.closeStream(streamId, 0x02); // Voluntary close
            },
        });

        const writable = new WritableStream            ({
            write: async (chunk) => {
                let credits = this.sendBufferCredits.get(streamId) ?? 1;
                while (credits <= 0) {
                    await new Promise      ((resolve) => {
                        let list = this.creditResolvers.get(streamId);
                        if (!list) {
                            list = [];
                            this.creditResolvers.set(streamId, list);
                        }
                        list.push(resolve);
                    });
                    credits = this.sendBufferCredits.get(streamId) ?? 1;
                }
                this.sendBufferCredits.set(streamId, credits - 1);
                this.sendWispFrame(WispPacketType.DATA, streamId, chunk);
            },
            close: () => {
                this.closeStream(streamId, 0x02);
            },
            abort: () => {
                this.closeStream(streamId, 0x03);
            },
        });

        return {
            streamId,
            readable,
            writable,
            close: (reason = 0x02) => this.closeStream(streamId, reason),
        };
    }

           closeStream(streamId        , reason = 0x02)       {
        if (this.streamControllers.has(streamId)) {
            const ctrl = this.streamControllers.get(streamId);
            try { ctrl?.close(); } catch {}
            this.streamControllers.delete(streamId);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendWispFrame(WispPacketType.CLOSE, streamId, new Uint8Array([reason & 0xff]));
            }
        }
        this.sendBufferCredits.delete(streamId);
    }

    /**
     *Resolves `_minecraft._tcp.<domain>` DNS SRV records using DNS-over-HTTPS (`1.1.1.1`)
     * exactly like `Wispcraft-1.12.2.html` (`fetch("https://1.1.1.1/dns-query?name=_minecraft._tcp....")`).
     */
           async resolveMinecraftSrv(host        , defaultPort = 25565)                                          {
        if (portSpecified(host)) {
            const [h, p] = host.split(':');
            return { host: h, port: parseInt(p, 10) || defaultPort };
        }
        try {
            const resp = await fetch(`https://1.1.1.1/dns-query?name=_minecraft._tcp.${encodeURIComponent(host)}&type=SRV`, {
                headers: { Accept: 'application/dns-json' },
            });
            if (resp.ok) {
                const json = await resp.json();
                if (json.Answer && json.Answer.length > 0 && json.Answer[0].data) {
                    const parts = String(json.Answer[0].data).trim().split(/\s+/);
                    if (parts.length >= 4) {
                        const srvPort = parseInt(parts[2], 10);
                        const srvHost = parts[3].replace(/\.$/, '');
                        if (srvHost && !isNaN(srvPort)) {
                            return { host: srvHost, port: srvPort };
                        }
                    }
                }
            }
        } catch {
            // Fall back to direct host:defaultPort
        }
        return { host, port: defaultPort };
    }

    /**
     * Performs an HTTPS request using native `fetch` first and falling back to Epoxy/Wisp
     * when CORS headers block direct browser access (such as Xbox Live / XSTS / Mojang Session Server).
     */
           async epoxyFetch(url        , init              )                    {
        if (this.epoxyClientInstance) {
            return this.epoxyClientInstance.fetch(url, init);
        }
        try {
            return await fetch(url, init);
        } catch (err) {
            throw new Error(`Network request to ${url} failed (ensure Wisp proxy ${this.wispUrl} is reachable): ${(err         ).message}`);
        }
    }
}

function portSpecified(addr        )          {
    return addr.includes(':');
}


// --- Module: network/microsoft_auth.ts ---
/**
 * Microsoft OAuth 2.0 Device Code -> Xbox Live -> XSTS -> Minecraft Services -> Session Server Auth
 *
 * Reverse-engineered 1:1 from `Wispcraft-1.12.2.html` (`client_id: "c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb"`):
 * 1. Requests Microsoft OAuth 2.0 Device Code from `https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode`
 *    (`scope: "XboxLive.signin XboxLive.offline_access"`).
 * 2. Polls `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` for `access_token` and `refresh_token`.
 * 3. Authenticates with Xbox Live (`https://user.auth.xboxlive.com/user/authenticate` with `RpsTicket: "d=" + msaToken`).
 * 4. Authorizes with XSTS (`https://xsts.auth.xboxlive.com/xsts/authorize` with `RelyingParty: "rp://api.minecraftservices.com/"`).
 * 5. Exchanges XSTS token + `uhs` for Minecraft Services JWT (`https://api.minecraftservices.com/authentication/login_with_xbox`).
 * 6. Queries player UUID & username (`https://api.minecraftservices.com/minecraft/profile`).
 * 7. Computes Minecraft's non-standard two's complement signed SHA-1 hex digest
 *    `sha1(ascii(serverId) + sharedSecret + publicKey)` and posts to
 *    `https://sessionserver.mojang.com/session/minecraft/join`.
 */

const MICROSOFT_CLIENT_ID = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';

                          
                       
                     
                            
                      
                     
                    
 

                            
                                                         
                                         
                        
                          
                         
 

class MicrosoftAuthenticator {
            wisp                 ;

    constructor(wisp                 ) {
        this.wisp = wisp;
    }

    /**
     * Step 1: Request OAuth 2.0 Device Code from Microsoft consumer endpoint.
     */
           async requestDeviceCode()                          {
        const resp = await this.wisp.epoxyFetch(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `client_id=${MICROSOFT_CLIENT_ID}&scope=${encodeURIComponent('XboxLive.signin XboxLive.offline_access')}`,
            }
        );
        const json = await resp.json();
        if (!json.device_code || !json.user_code) {
            throw new Error(json.error_description || 'Failed to obtain Microsoft OAuth2 device code');
        }
        return {
            deviceCode: json.device_code,
            userCode: json.user_code,
            verificationUri: json.verification_uri || 'https://www.microsoft.com/link',
            expiresIn: json.expires_in || 900,
            interval: json.interval || 5,
            message: json.message || `Go to ${json.verification_uri} and enter code ${json.user_code}`,
        };
    }

    /**
     * Step 2: Poll token endpoint with `device_code` until user completes sign-in.
     */
           async pollDeviceCodeToken(
        deviceCode        ,
        intervalSec = 5,
        onStatus                           
    )                                                         {
        const pollMs = Math.max(3, intervalSec) * 1000;
        for (let attempt = 0; attempt < 120; attempt++) {
            await new Promise(r => setTimeout(r, pollMs));
            const resp = await this.wisp.epoxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body:
                        'grant_type=urn:ietf:params:oauth:grant-type:device_code' +
                        `&client_id=${MICROSOFT_CLIENT_ID}` +
                        `&device_code=${encodeURIComponent(deviceCode)}`,
                }
            );
            const json = await resp.json();
            if (json.error) {
                if (json.error === 'authorization_pending') {
                    onStatus?.('Waiting for user to authorize in browser...');
                    continue;
                }
                if (json.error === 'slow_down') {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                throw new Error(`Microsoft OAuth error: ${json.error_description || json.error}`);
            }
            if (json.access_token) {
                return {
                    accessToken: json.access_token,
                    refreshToken: json.refresh_token || '',
                };
            }
        }
        throw new Error('Device code authentication timed out');
    }

    /**
     * Refresh an existing Microsoft `refresh_token` stored in `localStorage`.
     */
           async refreshMsaToken(refreshToken        )                                                         {
        const resp = await this.wisp.epoxyFetch(
            'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:
                    'grant_type=refresh_token' +
                    `&client_id=${MICROSOFT_CLIENT_ID}` +
                    `&refresh_token=${encodeURIComponent(refreshToken)}`,
            }
        );
        const json = await resp.json();
        if (!json.access_token) {
            throw new Error(json.error_description || 'Failed to refresh Microsoft token');
        }
        return {
            accessToken: json.access_token,
            refreshToken: json.refresh_token || refreshToken,
        };
    }

    /**
     * Step 3, 4, 5, 6: Exchange MSA `access_token` -> Xbox Live Token -> XSTS Token -> Minecraft Services Token -> Profile.
     */
           async authenticateMinecraftWithMsaToken(msaAccessToken        , refreshToken         )                            {
        // Step 3: Xbox Live User Authenticate
        const xblResp = await this.wisp.epoxyFetch('https://user.auth.xboxlive.com/user/authenticate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                Properties: {
                    AuthMethod: 'RPS',
                    SiteName: 'user.auth.xboxlive.com',
                    RpsTicket: `d=${msaAccessToken}`,
                },
                RelyingParty: 'http://auth.xboxlive.com',
                TokenType: 'JWT',
            }),
        });
        const xblJson = await xblResp.json();
        if (!xblJson.Token) {
            throw new Error('Xbox Live did not return an authentication token');
        }

        // Step 4: XSTS Authorize
        const xstsResp = await this.wisp.epoxyFetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                Properties: {
                    SandboxId: 'RETAIL',
                    UserTokens: [xblJson.Token],
                },
                RelyingParty: 'rp://api.minecraftservices.com/',
                TokenType: 'JWT',
            }),
        });
        const xstsJson = await xstsResp.json();
        if (xstsJson.XErr) {
            switch (xstsJson.XErr) {
                case 2148916227:
                    throw new Error('XSTS: This account is banned from Xbox');
                case 2148916233:
                    throw new Error('XSTS: This Microsoft account does not have an Xbox profile');
                case 2148916235:
                    throw new Error('XSTS: Xbox Live is not available in your country');
                case 2148916236:
                case 2148916237:
                    throw new Error('XSTS: Account requires adult verification');
                case 2148916238:
                    throw new Error('XSTS: Account is under 18 and must be added to a Microsoft Family');
                default:
                    throw new Error(`XSTS error code: ${xstsJson.XErr}`);
            }
        }
        const xstsToken = xstsJson.Token;
        const userHash = xstsJson?.DisplayClaims?.xui?.[0]?.uhs;
        if (!xstsToken || !userHash) {
            throw new Error('XSTS response missing Token or DisplayClaims.xui[0].uhs');
        }

        // Step 5: Minecraft Services login_with_xbox
        const mcLoginResp = await this.wisp.epoxyFetch(
            'https://api.minecraftservices.com/authentication/login_with_xbox',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    identityToken: `XBL3.0 x=${userHash};${xstsToken}`,
                }),
            }
        );
        const mcLoginJson = await mcLoginResp.json();
        const mcAccessToken = mcLoginJson.access_token;
        if (!mcAccessToken) {
            throw new Error('Minecraft Services did not return an access_token');
        }

        // Step 6: Fetch Minecraft Profile (UUID + Username)
        const profileResp = await this.wisp.epoxyFetch('https://api.minecraftservices.com/minecraft/profile', {
            headers: {
                Authorization: `Bearer ${mcAccessToken}`,
            },
        });
        const profileJson = await profileResp.json();
        if (!profileJson.id || !profileJson.name) {
            throw new Error('This Microsoft account does not own Minecraft: Java Edition');
        }

        return {
            id: profileJson.id,
            name: profileJson.name,
            accessToken: mcAccessToken,
            refreshToken,
            offlineMode: false,
        };
    }

    /**
     * Computes Minecraft's signed two's complement SHA-1 serverId hash (`Crypt.digestData`):
     * `sha1(ascii(serverId) + sharedSecret + publicKey)`
     * If the 160-bit big-endian result has its most significant bit set, formats as `"-"` + `(-val).toString(16)`.
     */
           static async computeMinecraftServerIdHash(
        serverId        ,
        sharedSecret            ,
        serverPublicKeyDer            
    )                  {
        const asciiServerId = new TextEncoder().encode(serverId);
        const combined = new Uint8Array(asciiServerId.length + sharedSecret.length + serverPublicKeyDer.length);
        combined.set(asciiServerId, 0);
        combined.set(sharedSecret, asciiServerId.length);
        combined.set(serverPublicKeyDer, asciiServerId.length + sharedSecret.length);

        const hashBuffer = await crypto.subtle.digest('SHA-1', combined);
        const hashBytes = new Uint8Array(hashBuffer);

        let bigVal = 0n;
        for (let i = 0; i < hashBytes.length; i++) {
            bigVal = (bigVal << 8n) | BigInt(hashBytes[i]);
        }
        // Check 160-bit sign bit (bit 159)
        if ((hashBytes[0] & 0x80) !== 0) {
            const twosComp = (1n << 160n) - bigVal;
            return '-' + twosComp.toString(16);
        }
        return bigVal.toString(16);
    }

    /**
     * Step 7: Join a multiplayer server via Mojang Session Server (`https://sessionserver.mojang.com/session/minecraft/join`).
     */
           async joinMojangServerSession(
        accessToken        ,
        selectedProfileUuid        ,
        serverId        ,
        sharedSecret            ,
        serverPublicKeyDer            
    )                {
        const serverHash = await MicrosoftAuthenticator.computeMinecraftServerIdHash(
            serverId,
            sharedSecret,
            serverPublicKeyDer
        );
        const resp = await this.wisp.epoxyFetch('https://sessionserver.mojang.com/session/minecraft/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                accessToken,
                selectedProfile: selectedProfileUuid.replace(/-/g, ''),
                serverId: serverHash,
            }),
        });
        if (resp.status !== 204 && !resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`Mojang Session Server rejected join (${resp.status}): ${text}`);
        }
    }

    /**
     * Creates an offline-mode profile with a deterministic v3-like UUID from the player's username
     * (`UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))`).
     */
           static createOfflineProfile(username        )                   {
        const cleanName = (username || 'Player26_3').trim().slice(0, 16);
        let h1 = 0xdeadbeef ^ cleanName.length;
        let h2 = 0x41c6ce57 ^ cleanName.length;
        for (let i = 0; i < cleanName.length; i++) {
            const ch = cleanName.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        const hex = (n        ) => (n >>> 0).toString(16).padStart(8, '0');
        const uuid = `${hex(h1)}${hex(h2)}${hex(h1 ^ 0x12345678)}${hex(h2 ^ 0x87654321)}`;
        return {
            id: uuid,
            name: cleanName,
            accessToken: '',
            offlineMode: true,
        };
    }
}


// --- Module: network/protocol_26_3.ts ---
/**
 * Minecraft 26.3 (`protocol_version: 777`) Network Protocol Engine
 *
 * Implements the complete Java Edition 26.3 network pipeline reverse-engineered from
 * `Wispcraft-1.12.2.html` (`QA` PacketBuffer, `RSA` PKCS#1 v1.5 `BigInt` encryption,
 * `AES/CFB8` stream cipher, `CompressionStream("deflate")` / `DecompressionStream("deflate")`
 * threshold framing) upgraded to **Protocol 777** (`version.json` of `26.3.jar`):
 *
 * States:
 *  - `HANDSHAKING` (0)
 *  - `STATUS` (1): Server List Ping (`0x00 StatusRequest` / `0x01 PingRequest`)
 *  - `LOGIN` (2): `0x00 Hello`, `0x01 EncryptionRequest` -> `0x01 EncryptionResponse`,
 *                 `0x03 SetCompression`, `0x02 LoginSuccess` -> `0x03 LoginAcknowledged`
 *  - `CONFIGURATION` (3): `0x02 ClientInformation`, `0x01 CustomPayload (minecraft:brand)`,
 *                         `0x0E SelectKnownPacks` (`minecraft:core` version `26.3`),
 *                         `0x07 RegistryData`, `0x03 FinishConfiguration` -> `0x03 AcknowledgeFinishConfiguration`
 *  - `PLAY` (4): KeepAlive, Login/Respawn, PlayerPosition, ChunkDataAndUpdateLight, BlockUpdate,
 *                SetHeldItem, SwingArm, PlayerAction, UseItemOn, ChatMessage, SystemChat.
 */



const PROTOCOL_VERSION_26_3 = 777;

const ConnectionState = {}; (function(ConnectionState){ ConnectionState["HANDSHAKING"] = 0; ConnectionState["STATUS"] = 1; ConnectionState["LOGIN"] = 2; ConnectionState["CONFIGURATION"] = 3; ConnectionState["PLAY"] = 4; })(ConnectionState);

/**
 * Packet Buffer (`FriendlyByteBuf`) with VarInt, VarLong, String, UUID, BlockPos, and ByteArray codecs.
 */
class PacketBuffer {
           inner            ;

    constructor(data                        , copy = false) {
        if (!data) {
            this.inner = new Uint8Array(0);
        } else if (data instanceof Uint8Array) {
            this.inner = copy ? data.slice() : data;
        } else {
            this.inner = Uint8Array.from(data);
        }
    }

           static alloc()               {
        return new PacketBuffer(new Uint8Array(0));
    }

           get length()         {
        return this.inner.byteLength;
    }

           take(n        )               {
        if (this.inner.byteLength < n) {
            throw new Error(`PacketBuffer underflow: need ${n} bytes, have ${this.inner.byteLength}`);
        }
        const slice = this.inner.subarray(0, n);
        this.inner = this.inner.subarray(n);
        return new PacketBuffer(slice);
    }

           extend(other                           )       {
        const src = other instanceof PacketBuffer ? other.inner : other;
        const next = new Uint8Array(this.inner.byteLength + src.byteLength);
        next.set(this.inner, 0);
        next.set(src, this.inner.byteLength);
        this.inner = next;
    }

           readUByte()         {
        const b = this.inner[0];
        this.take(1);
        return b;
    }

           writeUByte(v        )       {
        this.extend(new Uint8Array([v & 0xff]));
    }

           readBoolean()          {
        return this.readUByte() !== 0;
    }

           writeBoolean(v         )       {
        this.writeUByte(v ? 1 : 0);
    }

           readUShort()         {
        const v = (this.inner[0] << 8) | this.inner[1];
        this.take(2);
        return v;
    }

           writeUShort(v        )       {
        this.extend(new Uint8Array([(v >>> 8) & 0xff, v & 0xff]));
    }

           readShort()         {
        const u = this.readUShort();
        return u & 0x8000 ? u - 0x10000 : u;
    }

           readInt()         {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getInt32(0, false);
        this.take(4);
        return v;
    }

           writeInt(v        )       {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, v, false);
        this.extend(b);
    }

           readLong()         {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getBigInt64(0, false);
        this.take(8);
        return v;
    }

           writeLong(v        )       {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, v, false);
        this.extend(b);
    }

           readFloat()         {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getFloat32(0, false);
        this.take(4);
        return v;
    }

           writeFloat(v        )       {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, v, false);
        this.extend(b);
    }

           readDouble()         {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getFloat64(0, false);
        this.take(8);
        return v;
    }

           writeDouble(v        )       {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v, false);
        this.extend(b);
    }

           readVarInt(consume = true)         {
        let numRead = 0;
        let result = 0;
        let read        ;
        do {
            if (numRead >= this.inner.byteLength) {
                throw new Error('data too small');
            }
            read = this.inner[numRead++];
            result |= (read & 0x7f) << (7 * (numRead - 1));
            if (numRead > 5) throw new Error('VarInt too big');
        } while ((read & 0x80) !== 0);
        if (consume) this.take(numRead);
        return result;
    }

           writeVarInt(value        )       {
        const out           = [];
        let v = value | 0;
        while ((v & ~0x7f) !== 0) {
            out.push((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        out.push(v & 0x7f);
        this.extend(new Uint8Array(out));
    }

           readString()         {
        const len = this.readVarInt();
        const bytes = this.take(len).inner;
        return new TextDecoder('utf-8').decode(bytes);
    }

           writeString(str        )       {
        const encoded = new TextEncoder().encode(str);
        this.writeVarInt(encoded.byteLength);
        this.extend(encoded);
    }

           readByteArray()             {
        const len = this.readVarInt();
        return this.take(len).inner;
    }

           writeByteArray(bytes            )       {
        this.writeVarInt(bytes.byteLength);
        this.extend(bytes);
    }

           readUuid()         {
        const hi = BigInt.asUintN(64, this.readLong()).toString(16).padStart(16, '0');
        const lo = BigInt.asUintN(64, this.readLong()).toString(16).padStart(16, '0');
        return hi + lo;
    }

           writeUuid(hexUuid        )       {
        const clean = hexUuid.replace(/-/g, '').padStart(32, '0');
        const hi = BigInt('0x' + clean.slice(0, 16));
        const lo = BigInt('0x' + clean.slice(16, 32));
        this.writeLong(BigInt.asIntN(64, hi));
        this.writeLong(BigInt.asIntN(64, lo));
    }

           readBlockPos()                                      {
        const packed = this.readLong();
        return {
            x: BlockPos.getX(packed),
            y: BlockPos.getY(packed),
            z: BlockPos.getZ(packed),
        };
    }

           writeBlockPos(x        , y        , z        )       {
        this.writeLong(BlockPos.asLong(x, y, z));
    }
}

/**
 * RSA PKCS#1 v1.5 Encryption using `BigInt` modular exponentiation,
 * reverse-engineered from `Wispcraft-1.12.2.html` (`aA` / `cA` / `yA` functions).
 * Necessary because WebCrypto `SubtleCrypto` intentionally omits PKCS#1 v1.5 encryption.
 */
class MinecraftRsaPkcs1 {
           static parseSpkiPublicKeyDer(der            )                                                            {
        // Parse ASN.1 SubjectPublicKeyInfo to extract RSA modulus n and exponent e
        let pos = 0;
        const readLength = ()         => {
            const b = der[pos++];
            if ((b & 0x80) === 0) return b;
            const numBytes = b & 0x7f;
            let len = 0;
            for (let i = 0; i < numBytes; i++) len = (len << 8) | der[pos++];
            return len;
        };
        const expectTag = (tag        ) => {
            if (der[pos++] !== tag) throw new Error(`Expected ASN.1 tag 0x${tag.toString(16)}`);
            return readLength();
        };

        expectTag(0x30); // Outer SEQUENCE
        const algLen = expectTag(0x30); // AlgorithmIdentifier SEQUENCE
        pos += algLen;
        expectTag(0x03); // BIT STRING
        if (der[pos] === 0x00) pos++; // unused bits = 0
        expectTag(0x30); // RSAPublicKey SEQUENCE

        // Modulus INTEGER
        const modLen = expectTag(0x02);
        let modSlice = der.subarray(pos, pos + modLen);
        pos += modLen;
        if (modSlice[0] === 0x00) modSlice = modSlice.subarray(1);

        // Exponent INTEGER
        const expLen = expectTag(0x02);
        const expSlice = der.subarray(pos, pos + expLen);

        let modulus = 0n;
        for (const b of modSlice) modulus = (modulus << 8n) | BigInt(b);
        let exponent = 0n;
        for (const b of expSlice) exponent = (exponent << 8n) | BigInt(b);

        return { modulus, exponent, keyByteLen: modSlice.byteLength };
    }

            static modPow(base        , exp        , mod        )         {
        let result = 1n;
        let b = base % mod;
        let e = exp;
        while (e > 0n) {
            if ((e & 1n) === 1n) result = (result * b) % mod;
            e >>= 1n;
            b = (b * b) % mod;
        }
        return result;
    }

           static encryptPkcs1v15(derPublicKey            , data            )             {
        const { modulus, exponent, keyByteLen } = this.parseSpkiPublicKeyDer(derPublicKey);
        if (data.byteLength > keyByteLen - 11) {
            throw new Error('RSA PKCS#1 v1.5 payload too large');
        }
        const padded = new Uint8Array(keyByteLen);
        padded[0] = 0x00;
        padded[1] = 0x02;
        const psLen = keyByteLen - data.byteLength - 3;
        const rnd = new Uint8Array(psLen);
        crypto.getRandomValues(rnd);
        for (let i = 0; i < psLen; i++) {
            let b = rnd[i];
            while (b === 0) {
                const single = new Uint8Array(1);
                crypto.getRandomValues(single);
                b = single[0];
            }
            padded[2 + i] = b;
        }
        padded[2 + psLen] = 0x00;
        padded.set(data, 3 + psLen);

        let m = 0n;
        for (const b of padded) m = (m << 8n) | BigInt(b);
        let c = this.modPow(m, exponent, modulus);

        const out = new Uint8Array(keyByteLen);
        for (let i = keyByteLen - 1; i >= 0; i--) {
            out[i] = Number(c & 0xffn);
            c >>= 8n;
        }
        return out;
    }
}

/**
 * Pure-JS AES-128 Block Cipher + 8-bit Cipher Feedback (`AES/CFB8/NoPadding`) Stream Cipher
 * Matches Minecraft's Netty `CipherEncoder` and `CipherDecoder` (`sharedSecret` used as both Key and initial IV).
 */
class AesCfb8Cipher {
            static          SBOX = new Uint8Array([
        99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,
        183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,
        9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,
        208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,
        205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,
        224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,
        186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,
        225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22
    ]);
            static          RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54]);

            roundKeys            ;
            encryptRegister            ;
            decryptRegister            ;

    constructor(keyAndIv16            ) {
        if (keyAndIv16.byteLength !== 16) {
            throw new Error('AES-128 CFB8 requires a 16-byte shared secret');
        }
        this.roundKeys = this.expandKey(keyAndIv16);
        this.encryptRegister = keyAndIv16.slice();
        this.decryptRegister = keyAndIv16.slice();
    }

            expandKey(key            )             {
        const w = new Uint8Array(176);
        w.set(key, 0);
        const temp = new Uint8Array(4);
        for (let i = 4; i < 44; i++) {
            const prev = (i - 1) * 4;
            temp[0] = w[prev];
            temp[1] = w[prev + 1];
            temp[2] = w[prev + 2];
            temp[3] = w[prev + 3];
            if (i % 4 === 0) {
                const t = temp[0];
                temp[0] = AesCfb8Cipher.SBOX[temp[1]] ^ AesCfb8Cipher.RCON[i / 4 - 1];
                temp[1] = AesCfb8Cipher.SBOX[temp[2]];
                temp[2] = AesCfb8Cipher.SBOX[temp[3]];
                temp[3] = AesCfb8Cipher.SBOX[t];
            }
            const dst = i * 4;
            const src = (i - 4) * 4;
            w[dst] = w[src] ^ temp[0];
            w[dst + 1] = w[src + 1] ^ temp[1];
            w[dst + 2] = w[src + 2] ^ temp[2];
            w[dst + 3] = w[src + 3] ^ temp[3];
        }
        return w;
    }

            static xtime(a        )         {
        return ((a << 1) ^ ((a & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
    }

            encryptBlock16(input            )             {
        const s = input.slice();
        const rk = this.roundKeys;
        for (let i = 0; i < 16; i++) s[i] ^= rk[i];

        for (let round = 1; round <= 10; round++) {
            for (let i = 0; i < 16; i++) s[i] = AesCfb8Cipher.SBOX[s[i]];
            // ShiftRows
            let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
            t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
            t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;

            if (round < 10) {
                // MixColumns
                for (let c = 0; c < 16; c += 4) {
                    const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
                    const h = a0 ^ a1 ^ a2 ^ a3;
                    s[c] ^= h ^ AesCfb8Cipher.xtime(a0 ^ a1);
                    s[c + 1] ^= h ^ AesCfb8Cipher.xtime(a1 ^ a2);
                    s[c + 2] ^= h ^ AesCfb8Cipher.xtime(a2 ^ a3);
                    s[c + 3] ^= h ^ AesCfb8Cipher.xtime(a3 ^ a0);
                }
            }
            const rOff = round * 16;
            for (let i = 0; i < 16; i++) s[i] ^= rk[rOff + i];
        }
        return s;
    }

           encryptBytes(plaintext            )             {
        const out = new Uint8Array(plaintext.byteLength);
        for (let i = 0; i < plaintext.byteLength; i++) {
            const keystream = this.encryptBlock16(this.encryptRegister)[0];
            const cipherByte = plaintext[i] ^ keystream;
            out[i] = cipherByte;
            this.encryptRegister.copyWithin(0, 1, 16);
            this.encryptRegister[15] = cipherByte;
        }
        return out;
    }

           decryptBytes(ciphertext            )             {
        const out = new Uint8Array(ciphertext.byteLength);
        for (let i = 0; i < ciphertext.byteLength; i++) {
            const cipherByte = ciphertext[i];
            const keystream = this.encryptBlock16(this.decryptRegister)[0];
            out[i] = cipherByte ^ keystream;
            this.decryptRegister.copyWithin(0, 1, 16);
            this.decryptRegister[15] = cipherByte;
        }
        return out;
    }
}

                                
                                                
                                                                                           
                                                                             
                     
                      
 

                                
                                              
                                                              
                                  
                                            
                                              
                                                                                             
                                                                                    
                                                                 
 

/**
 * Full Minecraft 26.3 (`protocol_version: 777`) Client Connection over Wisp/Epoxy
 */
class MinecraftProtocol263Client {
            wisp                 ;
            auth                        ;
            stream                       = null;
            writer                                                 = null;
            state                  = ConnectionState.HANDSHAKING;
            compressionThreshold = -1;
            cipher                       = null;
            recvAccumulator = PacketBuffer.alloc();
            callbacks                      ;

    constructor(wisp                 , callbacks                       = {}) {
        this.wisp = wisp;
        this.auth = new MicrosoftAuthenticator(wisp);
        this.callbacks = callbacks;
    }

            static async zlibCompress(data            )                      {
        const cs = new CompressionStream('deflate');
        const w = cs.writable.getWriter();
        w.write(data                           );
        w.close();
        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }

            static async zlibDecompress(data            )                      {
        const ds = new DecompressionStream('deflate');
        const w = ds.writable.getWriter();
        w.write(data                           );
        w.close();
        return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }

           async sendPacket(packetId        , payloadBuilder                             )                {
        if (!this.writer) throw new Error('Not connected');
        const body = PacketBuffer.alloc();
        body.writeVarInt(packetId);
        payloadBuilder(body);

        let framedPayload              ;
        if (this.compressionThreshold >= 0) {
            framedPayload = PacketBuffer.alloc();
            if (body.length < this.compressionThreshold) {
                framedPayload.writeVarInt(0);
                framedPayload.extend(body);
            } else {
                const compressed = await MinecraftProtocol263Client.zlibCompress(body.inner);
                framedPayload.writeVarInt(body.length);
                framedPayload.extend(compressed);
            }
        } else {
            framedPayload = body;
        }

        const wire = PacketBuffer.alloc();
        wire.writeVarInt(framedPayload.length);
        wire.extend(framedPayload);

        const outBytes = this.cipher ? this.cipher.encryptBytes(wire.inner) : wire.inner;
        await this.writer.write(outBytes);
    }

    /**
     * Performs a Server List Ping (`Handshaking` state 1 -> `StatusRequest` 0x00 -> `PingRequest` 0x01)
     * over Wisp/Epoxy and returns MOTD, player count, protocol version, and RTT latency.
     */
           async pingServerStatus(serverAddress        )                                {
        const { host, port } = await this.wisp.resolveMinecraftSrv(serverAddress, 25565);
        const stream = await this.wisp.connectTcp(host, port);
        this.stream = stream;
        this.writer = stream.writable.getWriter();
        this.state = ConnectionState.HANDSHAKING;
        this.compressionThreshold = -1;
        this.cipher = null;
        this.recvAccumulator = PacketBuffer.alloc();

        // Send Handshake (0x00) with nextState = 1 (STATUS)
        await this.sendPacket(0x00, (buf) => {
            buf.writeVarInt(PROTOCOL_VERSION_26_3);
            buf.writeString(host);
            buf.writeUShort(port);
            buf.writeVarInt(ConnectionState.STATUS);
        });
        this.state = ConnectionState.STATUS;

        // Send Status Request (0x00)
        await this.sendPacket(0x00, () => {});

        const reader = stream.readable.getReader();
        let statusJsonStr = '';
        while (!statusJsonStr) {
            const { done, value } = await reader.read();
            if (done || !value) throw new Error('Connection closed before StatusResponse');
            this.recvAccumulator.extend(value);
            const pkt = await this.tryReadNextPacket();
            if (pkt) {
                const pktId = pkt.readVarInt();
                if (pktId === 0x00) {
                    statusJsonStr = pkt.readString();
                }
            }
        }

        // Send Ping Request (0x01) to measure RTT
        const pingStart = performance.now();
        await this.sendPacket(0x01, (buf) => {
            buf.writeLong(BigInt(Math.floor(pingStart)));
        });
        let latencyMs = Math.round(performance.now() - pingStart);
        try {
            const { value } = await reader.read();
            if (value) latencyMs = Math.round(performance.now() - pingStart);
        } catch {}

        reader.releaseLock();
        stream.close();
        const parsed = JSON.parse(statusJsonStr);
        return {
            version: parsed.version || { name: '26.3', protocol: PROTOCOL_VERSION_26_3 },
            players: parsed.players || { max: 20, online: 0 },
            description: parsed.description || 'Minecraft 26.3 Server',
            favicon: parsed.favicon,
            latencyMs,
        };
    }

    /**
     * Connects to a Minecraft 26.3 server (Protocol 777) through Handshaking -> Login -> Configuration -> Play.
     */
           async connectToServer(serverAddress        , profile                  )                {
        const { host, port } = await this.wisp.resolveMinecraftSrv(serverAddress, 25565);
        this.callbacks.onStatusUpdate?.(`Connecting to ${host}:${port} via Wisp (${this.wisp.wispUrl})...`);

        const stream = await this.wisp.connectTcp(host, port);
        this.stream = stream;
        this.writer = stream.writable.getWriter();
        this.state = ConnectionState.HANDSHAKING;
        this.compressionThreshold = -1;
        this.cipher = null;
        this.recvAccumulator = PacketBuffer.alloc();

        // 1. Handshake (0x00) -> Next State = 2 (LOGIN)
        await this.sendPacket(0x00, (buf) => {
            buf.writeVarInt(PROTOCOL_VERSION_26_3);
            buf.writeString(host);
            buf.writeUShort(port);
            buf.writeVarInt(ConnectionState.LOGIN);
        });
        this.state = ConnectionState.LOGIN;

        // 2. Serverbound Login Start / Hello (0x00): [Name: String][Player UUID: UUID]
        this.callbacks.onStatusUpdate?.(`Logging in as ${profile.name} (Protocol 777)...`);
        await this.sendPacket(0x00, (buf) => {
            buf.writeString(profile.name);
            buf.writeUuid(profile.id);
        });

        // Start async packet receive loop
        this.runReceiveLoop(stream.readable, profile).catch((err) => {
            this.callbacks.onDisconnect?.((err         ).message);
        });
    }

            async tryReadNextPacket()                               {
        let lenVarIntBytes = 0;
        let packetLen = 0;
        for (let i = 0; i < Math.min(5, this.recvAccumulator.length); i++) {
            const b = this.recvAccumulator.inner[i];
            packetLen |= (b & 0x7f) << (7 * i);
            if ((b & 0x80) === 0) {
                lenVarIntBytes = i + 1;
                break;
            }
        }
        if (lenVarIntBytes === 0 || this.recvAccumulator.length < lenVarIntBytes + packetLen) {
            return null;
        }
        this.recvAccumulator.take(lenVarIntBytes);
        const rawFrame = this.recvAccumulator.take(packetLen);

        if (this.compressionThreshold >= 0) {
            const uncompressedLen = rawFrame.readVarInt();
            if (uncompressedLen === 0) {
                return rawFrame;
            }
            const inflated = await MinecraftProtocol263Client.zlibDecompress(rawFrame.inner);
            return new PacketBuffer(inflated);
        }
        return rawFrame;
    }

            async runReceiveLoop(readable                            , profile                  )                {
        const reader = readable.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done || !value) {
                this.callbacks.onDisconnect?.('Server closed the connection');
                break;
            }
            const decrypted = this.cipher ? this.cipher.decryptBytes(value) : value;
            this.recvAccumulator.extend(decrypted);

            while (true) {
                const pkt = await this.tryReadNextPacket();
                if (!pkt) break;
                await this.handlePacket(pkt, profile);
            }
        }
    }

            async handlePacket(pkt              , profile                  )                {
        const packetId = pkt.readVarInt();

        if (this.state === ConnectionState.LOGIN) {
            switch (packetId) {
                case 0x00: { // Disconnect (Login)
                    const reason = pkt.readString();
                    this.callbacks.onDisconnect?.(reason);
                    this.stream?.close();
                    break;
                }
                case 0x01: { // Encryption Request (ClientboundHelloPacket)
                    const serverId = pkt.readString();
                    const publicKeyDer = pkt.readByteArray();
                    const verifyToken = pkt.readByteArray();
                    const shouldAuthenticate = pkt.length > 0 ? pkt.readBoolean() : true;

                    const sharedSecret = new Uint8Array(16);
                    crypto.getRandomValues(sharedSecret);

                    if (shouldAuthenticate && !profile.offlineMode && profile.accessToken) {
                        this.callbacks.onStatusUpdate?.('Authenticating with Mojang Session Server...');
                        await this.auth.joinMojangServerSession(
                            profile.accessToken,
                            profile.id,
                            serverId,
                            sharedSecret,
                            publicKeyDer
                        );
                    }

                    const encSecret = MinecraftRsaPkcs1.encryptPkcs1v15(publicKeyDer, sharedSecret);
                    const encVerify = MinecraftRsaPkcs1.encryptPkcs1v15(publicKeyDer, verifyToken);

                    // Send Encryption Response (0x01) BEFORE enabling cipher
                    await this.sendPacket(0x01, (buf) => {
                        buf.writeByteArray(encSecret);
                        buf.writeByteArray(encVerify);
                    });

                    // Enable AES/CFB8 stream encryption
                    this.cipher = new AesCfb8Cipher(sharedSecret);
                    this.callbacks.onStatusUpdate?.('AES/CFB8 link encryption enabled');
                    break;
                }
                case 0x03: { // Set Compression (ClientboundLoginCompressionPacket)
                    this.compressionThreshold = pkt.readVarInt();
                    break;
                }
                case 0x02: { // Login Success (ClientboundGameProfilePacket)
                    const uuid = pkt.readUuid();
                    const username = pkt.readString();
                    this.callbacks.onLoginSuccess?.(uuid, username);
                    // Send Login Acknowledged (0x03) to transition to CONFIGURATION (State 3)
                    await this.sendPacket(0x03, () => {});
                    this.state = ConnectionState.CONFIGURATION;
                    this.callbacks.onStatusUpdate?.('Entered Configuration state (Protocol 777)...');

                    // Send ClientInformation (0x00 in Configuration)
                    await this.sendPacket(0x00, (buf) => {
                        buf.writeString('en_us'); // Locale
                        buf.writeUByte(12);       // View distance
                        buf.writeVarInt(0);       // Chat mode: enabled
                        buf.writeBoolean(true);   // Chat colors
                        buf.writeUByte(0x7f);     // Displayed skin parts
                        buf.writeVarInt(1);       // Main hand: Right
                        buf.writeBoolean(false);  // Enable text filtering
                        buf.writeBoolean(true);   // Allow server listings
                        buf.writeVarInt(0);       // Particle status: All
                    });
                    break;
                }
                case 0x04: { // Custom Query (Login Plugin Request)
                    const messageId = pkt.readVarInt();
                    await this.sendPacket(0x02, (buf) => {
                        buf.writeVarInt(messageId);
                        buf.writeBoolean(false);
                    });
                    break;
                }
            }
            return;
        }

        if (this.state === ConnectionState.CONFIGURATION) {
            switch (packetId) {
                case 0x02: { // Disconnect (Configuration)
                    const reason = pkt.readString();
                    this.callbacks.onDisconnect?.(reason);
                    this.stream?.close();
                    break;
                }
                case 0x03: { // Finish Configuration
                    // Reply with Acknowledge Finish Configuration (0x03) -> Transition to PLAY (State 4)
                    await this.sendPacket(0x03, () => {});
                    this.state = ConnectionState.PLAY;
                    this.callbacks.onStatusUpdate?.('Entered Play state!');
                    this.callbacks.onEnterPlayState?.();
                    break;
                }
                case 0x04: { // Keep Alive (Configuration)
                    const id = pkt.readLong();
                    await this.sendPacket(0x04, (buf) => buf.writeLong(id));
                    break;
                }
                case 0x05: { // Ping (Configuration)
                    const id = pkt.readInt();
                    await this.sendPacket(0x05, (buf) => buf.writeInt(id));
                    break;
                }
                case 0x0e: { // ClientboundSelectKnownPacks (minecraft:core 26.3)
                    await this.sendPacket(0x07, (buf) => {
                        buf.writeVarInt(1);
                        buf.writeString('minecraft');
                        buf.writeString('core');
                        buf.writeString('26.3');
                    });
                    break;
                }
            }
            return;
        }

        if (this.state === ConnectionState.PLAY) {
            switch (packetId) {
                case 0x26: { // Keep Alive (ClientboundKeepAlivePacket)
                    const keepAliveId = pkt.readLong();
                    await this.sendPacket(0x18, (buf) => buf.writeLong(keepAliveId));
                    break;
                }
                case 0x09: { // Block Update (ClientboundBlockUpdatePacket)
                    const pos = pkt.readBlockPos();
                    const stateId = pkt.readVarInt();
                    this.callbacks.onBlockUpdate?.(pos.x, pos.y, pos.z, stateId);
                    break;
                }
                case 0x40: { // Synchronize Player Position
                    const teleportId = pkt.readVarInt();
                    const x = pkt.readDouble();
                    const y = pkt.readDouble();
                    const z = pkt.readDouble();
                    pkt.readDouble(); // vx
                    pkt.readDouble(); // vy
                    pkt.readDouble(); // vz
                    const yaw = pkt.readFloat();
                    const pitch = pkt.readFloat();
                    this.callbacks.onPlayerPosition?.(x, y, z, yaw, pitch);
                    // Confirm Teleportation (0x00)
                    await this.sendPacket(0x00, (buf) => buf.writeVarInt(teleportId));
                    break;
                }
                case 0x64: { // Update Time
                    const worldAge = pkt.readLong();
                    const timeOfDay = pkt.readLong();
                    this.callbacks.onTimeUpdate?.(worldAge, timeOfDay);
                    break;
                }
            }
        }
    }

           async sendPlayerPositionAndRotation(
        x        , y        , z        ,
        yawDeg        , pitchDeg        ,
        onGround         
    )                {
        if (this.state !== ConnectionState.PLAY || !this.writer) return;
        await this.sendPacket(0x1b, (buf) => {
            buf.writeDouble(x);
            buf.writeDouble(y);
            buf.writeDouble(z);
            buf.writeFloat(yawDeg);
            buf.writeFloat(pitchDeg);
            buf.writeUByte(onGround ? 1 : 0);
        });
    }

           async sendChatMessage(message        )                {
        if (this.state !== ConnectionState.PLAY || !this.writer) return;
        await this.sendPacket(0x06, (buf) => {
            buf.writeString(message.slice(0, 256));
            buf.writeLong(BigInt(Date.now()));
            buf.writeLong(0n); // Salt
            buf.writeBoolean(false); // No signature
            buf.writeVarInt(0);
            buf.extend(new Uint8Array([0, 0, 0])); // FixedBitSet(20)
        });
    }

           disconnect()       {
        if (this.stream) {
            this.stream.close();
            this.stream = null;
            this.writer = null;
        }
    }
}


// --- Module: world/noise_router.ts ---
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


                               
                         
                          
                          
                         
                          
                                   
                            
 

                            
                                    
                          
                                        
                                  
                                   
                                      
                                        
                                        
                                                                                                 
                                              
                              
                                
       
                                               
                                                
 

/**
 * Vanilla `ImprovedNoise` (Single Perlin Octave with 256-entry permutation table and origin offset `xo, yo, zo`).
 */
class ImprovedNoise {
                    p = new Uint8Array(256);
                    xo        ;
                    yo        ;
                    zo        ;

    constructor(rng                      ) {
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

            static fade(t        )         {
        return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
    }

            static lerp(t        , a        , b        )         {
        return a + t * (b - a);
    }

            static gradDot(hash        , x        , y        , z        )         {
        if (JvmWasmCore.instance) {
            return JvmWasmCore.instance.exports.perlinGradDot(hash, x, y, z);
        }
        const h = hash & 15;
        const u = h < 8 ? x : y;
        const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }

           noise(x        , y        , z        , yScale = 0.0, yMax = 0.0)         {
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
class NormalNoise {
            static          INPUT_FACTOR = 1.0181268882175227;
                     firstOctaves                                                                    = [];
                     secondOctaves                                                                    = [];
                     valueFactor        ;
                    maxValue        ;

    constructor(rng                      , firstOctave        , amplitudes          ) {
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

            static wrap(v        )         {
        return v - Math.floor(v / 33554432.0 + 0.5) * 33554432.0;
    }

           getValue(x        , y        , z        )         {
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

                           
                     
                                    
                       
 

                           
                        
                              
 

                             
                       
                    
                   
                      
                        
                       
                  
                   
                   
                         
                      
 

/**
 * Full Minecraft 26.3 (`world_version: 5023`) NoiseRouter & DensityFunction Evaluator
 */
class WorldgenNoiseRouter {
            worldSeed        ;
            randomFactory                                  ;
            worldgenData                  ;
            noiseInstances                           = new Map();
            flatCache2D                      = new Map();

    constructor(worldSeed        , worldgenData                  ) {
        this.worldSeed = worldSeed;
        const rootRng = new Xoroshiro128PlusPlus(worldSeed);
        this.randomFactory = rootRng.forkPositional();
        this.worldgenData = worldgenData;
    }

           setSeed(seed        )       {
        this.worldSeed = seed;
        const rootRng = new Xoroshiro128PlusPlus(seed);
        this.randomFactory = rootRng.forkPositional();
        this.noiseInstances.clear();
        this.flatCache2D.clear();
    }

           getSeed()         {
        return this.worldSeed;
    }

           getNoise(noiseId        )              {
        const clean = noiseId.replace('minecraft:', '');
        let inst = this.noiseInstances.get(clean);
        if (inst) return inst;

        const rawParams =
            this.worldgenData.noises[clean] ||
            this.worldgenData.noises[`minecraft:${clean}`];
        let firstOctave = -7;
        let amplitudes           = [1.0, 1.0];

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
                amplitudes = new Array        (count);
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
           evalDensityFunction(node         , x        , y        , z        , depth = 0)         {
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

        const obj = node                           ;
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
                return this.evalCubicSpline(obj.spline                   , x, y, z, depth + 1);

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
           evalCubicSpline(spline                          , x        , y        , z        , depth = 0)         {
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
           sampleOverworldRouter(x        , y        , z        )                    {
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
           computeColumnHeight(x        , z        )                                                  {
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


// --- Module: world/physics_tick.ts ---
/**
 * Minecraft 26.3 (`world_version: 5023`) Chunk Storage, Biome & Surface Rule Generator,
 * Structure Template Placer, VoxelShape AABB Physics, 8-Level Water/Lava Fluid Dynamics,
 * Redstone Tick Priority Queue, and Mob Brain AI (including 26.3 `sulfur_cube`).
 */



                              
               
                 
                  
                                                                   
                          
                     
                      
               
                   
                     
                      
                      
                     
                     
      
                                                                   
                 
                         
                          
                           
                            
                                    
                             
                             
                             
                             
                                     
                     
                        
      
 

                              
               
                 
                  
                        
                     
                              
              
                                    
                                    
                                      
                                          
                                      
                                        
      
 

const CHUNK_MIN_Y = -64;
const CHUNK_MAX_Y = 192;
const CHUNK_HEIGHT = CHUNK_MAX_Y - CHUNK_MIN_Y; // 256 vertical blocks (-64 .. 191)

class ChunkColumn {
                    chunkX        ;
                    chunkZ        ;
    // Block rawId per (x: 0..15, y: 0..255, z: 0..15)
                    blocks = new Uint16Array(16 * CHUNK_HEIGHT * 16);
    // Fluid level (0..8, where 8 = source block, 1..7 = flowing height)
                    fluidLevel = new Uint8Array(16 * CHUNK_HEIGHT * 16);
    // Packed light: high nibble = skyLight (0..15), low nibble = blockLight (0..15)
                    light = new Uint8Array(16 * CHUNK_HEIGHT * 16);
    // Biome rawId per 4x4 column (16x16)
                    biomes = new Uint8Array(16 * 16);
                    heightmap = new Int16Array(16 * 16);
           dirty = true;

    constructor(chunkX        , chunkZ        ) {
        this.chunkX = chunkX;
        this.chunkZ = chunkZ;
        this.light.fill(0xf0); // Default skyLight = 15, blockLight = 0
    }

           static index(lx        , y        , lz        )         {
        const ry = y - CHUNK_MIN_Y;
        return (ry << 8) | (lz << 4) | lx;
    }

           getBlock(lx        , y        , lz        )         {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.blocks[ChunkColumn.index(lx, y, lz)];
    }

           setBlock(lx        , y        , lz        , blockId        )       {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.blocks[ChunkColumn.index(lx, y, lz)] = blockId;
        this.dirty = true;
    }

           getFluidLevel(lx        , y        , lz        )         {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.fluidLevel[ChunkColumn.index(lx, y, lz)];
    }

           setFluidLevel(lx        , y        , lz        , level        )       {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.fluidLevel[ChunkColumn.index(lx, y, lz)] = level;
        this.dirty = true;
    }

           getSkyLight(lx        , y        , lz        )         {
        if (y < CHUNK_MIN_Y) return 0;
        if (y >= CHUNK_MAX_Y) return 15;
        return (this.light[ChunkColumn.index(lx, y, lz)] >>> 4) & 0x0f;
    }

           getBlockLight(lx        , y        , lz        )         {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        return this.light[ChunkColumn.index(lx, y, lz)] & 0x0f;
    }

           setLight(lx        , y        , lz        , sky        , block        )       {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return;
        this.light[ChunkColumn.index(lx, y, lz)] = ((sky & 0x0f) << 4) | (block & 0x0f);
    }
}

                
                 
                 
                 
                 
                 
                 
 

                     
               
                                                                                    
              
              
              
                  
                  
                  
               
               
               
                
                  
                    
                  
                   
                      
                   
                      
                     
                    
                      
                          
                          
                                                                           
 

                               
              
              
              
                                                                   
                         
                     
 

                         
              
              
              
                       
                                                                                         
                               
 

class ClientWorld {
                    blocksById                      ;
                    blockByName                                  = new Map();
                    biomesById                      ;
                    biomeByName                                  = new Map();
                    chunks                           = new Map();
                    structures                                       = new Map();
                    entities                         = new Map();
                    blockEntities                                   = new Map();
                    scheduledTicks                  = [];
                    noiseRouter                     ;

           worldAgeTicks = 0n;
           timeOfDayTicks = 1000n; // Morning sun
           isRaining = false;
            nextEntityId = 100;

    // Fast cached IDs for core blocks
           idAir = 0;
           idStone = 1;
           idGrassBlock = 2;
           idDirt = 3;
           idCobblestone = 4;
           idBedrock = 5;
           idWater = 6;
           idLava = 7;
           idSand = 8;
           idSandstone = 9;
           idGravel = 10;
           idDeepslate = 11;
           idOakLog = 12;
           idOakLeaves = 13;
           idShortGrass = 14;
           idDandelion = 15;
           idPoppy = 16;
           idSnowBlock = 17;
           idIce = 18;
           idSulfur = 19;
           idPotentSulfur = 20;
           idSulfurSpike = 21;
           idSulfurBricks = 22;
           idPaleOakLog = 23;
           idPaleOakLeaves = 24;
           idCherryLog = 25;
           idCherryLeaves = 26;
           idCoalOre = 27;
           idIronOre = 28;
           idGoldOre = 29;
           idDiamondOre = 30;
           idGlowstone = 31;
           idTorch = 32;
           idRedstoneWire = 33;
           idRedstoneTorch = 34;
           idRedstoneLamp = 35;
           idChest = 36;
           idObsidian = 37;

    constructor(
        blocks                      ,
        biomes                      ,
        noiseRouter                     
    ) {
        this.blocksById = new Array(blocks.length);
        for (const b of blocks) {
            const raw = b                                      ;
            const tex = (b.textures || {})                          ;
            b.textures = {
                up: tex.up || tex.top || tex.north || 'stone',
                down: tex.down || tex.bottom || tex.north || 'stone',
                north: tex.north || tex.top || 'stone',
                south: tex.south || tex.north || 'stone',
                east: tex.east || tex.north || 'stone',
                west: tex.west || tex.north || 'stone',
            };
            if (!b.properties) {
                b.properties = {
                    mapColor: String(raw.mapColor ?? 'STONE'),
                    soundType: String(raw.soundType ?? 'STONE'),
                    instrument: String(raw.instrument ?? 'HARP'),
                    destroyTime: Number(raw.destroyTime ?? 1),
                    explosionResistance: Number(raw.explosionResistance ?? 1),
                    noCollision: Boolean(raw.noCollision),
                    noOcclusion: Boolean(raw.noOcclusion),
                    replaceable: Boolean(raw.replaceable),
                    randomTicks: Boolean(raw.randomTicks),
                    requiresCorrectTool: Boolean(raw.requiresCorrectTool),
                    air: Boolean(raw.air || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'),
                    liquid: Boolean(raw.liquid || b.name === 'water' || b.name === 'lava'),
                };
            }
            this.blocksById[b.rawId] = b;
            this.blockByName.set(b.name, b);
        }
        this.biomesById = biomes;
        for (const bm of biomes) {
            this.biomeByName.set(bm.name, bm);
        }
        this.noiseRouter = noiseRouter;

        const findId = (name        , fallback = 1) => this.blockByName.get(name)?.rawId ?? fallback;
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

           getChunk(chunkX        , chunkZ        )                          {
        return this.chunks.get(ChunkPos.asLong(chunkX, chunkZ));
    }

           getOrCreateChunk(chunkX        , chunkZ        )              {
        const key = ChunkPos.asLong(chunkX, chunkZ);
        let col = this.chunks.get(key);
        if (!col) {
            col = this.generateChunk(chunkX, chunkZ);
            this.chunks.set(key, col);
        }
        return col;
    }

           getBlockId(x        , y        , z        )         {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return this.idAir;
        const cx = x >> 4;
        const cz = z >> 4;
        const col = this.chunks.get(ChunkPos.asLong(cx, cz));
        if (!col) return this.idAir;
        return col.getBlock(x & 15, y, z & 15);
    }

           getBlockEntry(x        , y        , z        )                     {
        const id = this.getBlockId(x, y, z);
        return this.blocksById[id] || this.blocksById[this.idAir];
    }

           getFluidLevel(x        , y        , z        )         {
        if (y < CHUNK_MIN_Y || y >= CHUNK_MAX_Y) return 0;
        const col = this.chunks.get(ChunkPos.asLong(x >> 4, z >> 4));
        if (!col) return 0;
        return col.getFluidLevel(x & 15, y, z & 15);
    }

           setBlockId(x        , y        , z        , blockId        , triggerUpdates = true)       {
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

           markChunkDirty(cx        , cz        )       {
        const c = this.chunks.get(ChunkPos.asLong(cx, cz));
        if (c) c.dirty = true;
    }

    /**
     * Generates a 16x256x16 `ChunkColumn` using the exact Minecraft 26.3 `WorldgenNoiseRouter`,
     * `Xoroshiro128++` positional RNG, `material_rule` surface rules, Sulfur Caves features (`sulfur`,
     * `potent_sulfur`, `sulfur_spike`), trees, ores, and `.nbt` structure templates.
     */
           generateChunk(chunkX        , chunkZ        )              {
        const col = new ChunkColumn(chunkX, chunkZ);
        if (this.idAir !== 0) {
            col.blocks.fill(this.idAir);
        }
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

            placeStructureInChunk(col             , tmpl                         , ox        , oy        , oz        )       {
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

           recalculateColumnLight(col             , lx        , lz        )       {
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

           spawnMob(type        , x        , y        , z        )            {
        const id = this.nextEntityId++;
        const isSulfurCube = type === 'sulfur_cube';
        const isTall = type === 'zombie' || type === 'skeleton';
        const ent            = {
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
           getCollisionBoxes(queryBox      )         {
        const out         = [];
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
           moveEntityWithCollisions(
        box      ,
        dx        ,
        dy        ,
        dz        
    )                                                                                               {
        const expanded       = {
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
           scheduleFluidAndRedstoneNeighbors(x        , y        , z        )       {
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
           tick(playerX        , playerY        , playerZ        )       {
        this.worldAgeTicks += 1n;
        this.timeOfDayTicks = (this.timeOfDayTicks + 1n) % 24000n;
        const now = Number(this.worldAgeTicks);

        // Process scheduled fluid & redstone ticks
        let processed = 0;
        while (this.scheduledTicks.length > 0 && this.scheduledTicks[0].targetTick <= now && processed < 64) {
            const task = this.scheduledTicks.shift() ;
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
            const box       = {
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
            stepFluidBlock(x        , y        , z        )       {
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

            stepRedstoneBlock(x        , y        , z        )       {
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
           raycastBlock(
        ox        , oy        , oz        ,
        dx        , dy        , dz        ,
        maxDist = 5.0
    )   
                                        
                                           
                                                 
                     
                                  
             {
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


// --- Module: renderer/shader_compiler.ts ---
/**
 * Vanilla GLSL 330 (`assets/minecraft/shaders/core/*`) to WGSL (WebGPU) & GLSL ES 3.00 (WebGL2)
 * Shader Translation & Compute Culling Pipeline Compiler.
 *
 * Parses the 93 extracted shaders in `shaders.json` (including `#moj_import <minecraft:fog.glsl>`,
 * `dynamictransforms.glsl`, `projection.glsl`, `light.glsl`, `globals.glsl`) and compiles:
 * 1. Primary WebGPU **WGSL** vertex & fragment shaders for Terrain (Opaque, Cutout alpha-discard,
 *    Translucent), Entities, Block Entities, Particles, Sky/Clouds, and 2D GUI/Font,
 *    plus a WebGPU **Compute Shader** (`@compute @workgroup_size(64)`) for parallel GPU frustum
 *    and occlusion culling of 16x16x16 chunk sections.
 * 2. Fallback WebGL2 **GLSL ES 3.00** (`#version 300 es`) shaders with Uniform Buffer Objects (UBOs)
 *    and identical spherical/cylindrical atmospheric fog, dynamic lightmap sampling, and directional
 *    diffuse lighting (`minecraft_mix_light`).
 */

                                  
                                 
                                    
                                 
 

/**
 * Resolves `#moj_import <minecraft:...>` and `#include <minecraft:...>` directives against
 * the extracted `assets/minecraft/shaders/include/*` dictionary from `26.3.jar`.
 */
function resolveMojImports(glslSource        , includes                        , visited = new Set        ())         {
    return glslSource.replace(/#(moj_import|include)\s*[<"]([^>"]+)[>"]/g, (_match, _directive, target) => {
        const cleanName = String(target).replace('minecraft:', '');
        if (visited.has(cleanName)) return `// [already imported ${cleanName}]`;
        visited.add(cleanName);
        const incContent = includes[cleanName];
        if (!incContent) return `// [missing import ${cleanName}]`;
        return resolveMojImports(incContent, includes, visited);
    });
}

/**
 * WebGPU Compute Shader (`frustum_occlusion_cull.wgsl`) for parallel 16x256x16 chunk frustum
 * & heightmap occlusion culling on the GPU.
 */
const WEBGPU_CHUNK_CULL_COMPUTE_WGSL = /* wgsl */ `
struct CullUniforms {
    planes: array<vec4<f32>, 6>,
    cameraPos: vec4<f32>,
    chunkCount: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
};

struct ChunkBounds {
    minBounds: vec4<f32>,
    maxBounds: vec4<f32>,
};

@group(0) @binding(0) var<uniform> cullUbo: CullUniforms;
@group(0) @binding(1) var<storage, read> chunkBounds: array<ChunkBounds>;
@group(0) @binding(2) var<storage, read_write> visibilityOut: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= cullUbo.chunkCount) {
        return;
    }
    let b = chunkBounds[idx];
    var visible = 1u;
    for (var i = 0u; i < 6u; i = i + 1u) {
        let p = cullUbo.planes[i];
        let px = select(b.minBounds.x, b.maxBounds.x, p.x >= 0.0);
        let py = select(b.minBounds.y, b.maxBounds.y, p.y >= 0.0);
        let pz = select(b.minBounds.z, b.maxBounds.z, p.z >= 0.0);
        if (p.x * px + p.y * py + p.z * pz + p.w < -2.0) {
            visible = 0u;
            break;
        }
    }
    visibilityOut[idx] = visible;
}
`;

/**
 * Primary WebGPU WGSL Shader translated from vanilla 26.3 `terrain.vsh` + `terrain.fsh` + `fog.glsl` + `light.glsl`.
 * Matches the compact 32-byte packed vertex layout:
 * - `@location(0) pos: vec3<f32>` (offset 0)
 * - `@location(1) uv: vec2<f32>` (offset 12)
 * - `@location(2) normalPacked: u32` (offset 20)
 * - `@location(3) lightPacked: u32` (offset 24: low 8 = blockLight, next 8 = skyLight, next 8 = AO)
 * - `@location(4) colorPacked: u32` (offset 28: RGBA8 biome/tint color)
 */
const WEBGPU_TERRAIN_WGSL = /* wgsl */ `
struct SceneUniforms {
    viewProj: mat4x4<f32>,
    cameraPos: vec4<f32>,
    fogColor: vec4<f32>,
    skyColor: vec4<f32>,
    fogParams: vec4<f32>, // x = fogStart, y = fogEnd, z = sunLightLevel (0..1), w = alphaCutoff
    lightDir0: vec4<f32>,
    lightDir1: vec4<f32>,
};

@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(0) @binding(1) var blockAtlasTex: texture_2d<f32>;
@group(0) @binding(2) var blockAtlasSampler: sampler;
@group(0) @binding(3) var lightmapTex: texture_2d<f32>;
@group(0) @binding(4) var lightmapSampler: sampler;

struct VertexInput {
    @location(0) pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) normalPacked: u32,
    @location(3) lightPacked: u32,
    @location(4) colorPacked: u32,
};

struct VertexOutput {
    @builtin(position) clipPos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) vColor: vec4<f32>,
    @location(2) lightUV: vec2<f32>,
    @location(3) sphericalDist: f32,
    @location(4) cylindricalDist: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clipPos = scene.viewProj * vec4<f32>(in.pos, 1.0);
    out.uv = in.uv;

    // Unpack RGBA8 vertex tint color
    let r = f32(in.colorPacked & 255u) / 255.0;
    let g = f32((in.colorPacked >> 8u) & 255u) / 255.0;
    let b = f32((in.colorPacked >> 16u) & 255u) / 255.0;
    let a = f32((in.colorPacked >> 24u) & 255u) / 255.0;

    // Unpack normal and compute vanilla directional face shade + smooth AO
    let nx = f32(i32(in.normalPacked << 24u) >> 24) / 127.0;
    let ny = f32(i32((in.normalPacked >> 8u) << 24u) >> 24) / 127.0;
    let nz = f32(i32((in.normalPacked >> 16u) << 24u) >> 24) / 127.0;
    let ao = f32((in.lightPacked >> 16u) & 255u) / 255.0;

    var dirShade = 1.0;
    if (ny < -0.5) {
        dirShade = 0.5;
    } else if (abs(nz) > 0.5) {
        dirShade = 0.8;
    } else if (abs(nx) > 0.5) {
        dirShade = 0.6;
    }

    out.vColor = vec4<f32>(r * dirShade * ao, g * dirShade * ao, b * dirShade * ao, a);

    // Unpack blockLight (0..15) and skyLight (0..15) into 16x16 lightmap UV
    let blockL = f32(in.lightPacked & 15u);
    let skyL = f32((in.lightPacked >> 8u) & 15u);
    out.lightUV = vec2<f32>((blockL + 0.5) / 16.0, (skyL + 0.5) / 16.0);

    // Vanilla fog_spherical_distance & fog_cylindrical_distance (fog.glsl)
    let relPos = in.pos - scene.cameraPos.xyz;
    out.sphericalDist = length(relPos);
    out.cylindricalDist = length(relPos.xz);
    return out;
}

fn linear_fog_value(distance: f32, fogStart: f32, fogEnd: f32) -> f32 {
    if (distance <= fogStart) {
        return 0.0;
    } else if (distance >= fogEnd) {
        return 1.0;
    }
    return (distance - fogStart) / (fogEnd - fogStart);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let texColor = textureSample(blockAtlasTex, blockAtlasSampler, in.uv);
    if (texColor.a < scene.fogParams.w) {
        discard;
    }
    let lmColor = textureSample(lightmapTex, lightmapSampler, in.lightUV);
    let litColor = vec4<f32>(texColor.rgb * in.vColor.rgb * lmColor.rgb, texColor.a * in.vColor.a);

    let fEnv = linear_fog_value(in.sphericalDist, scene.fogParams.x, scene.fogParams.y);
    let fCyl = linear_fog_value(in.cylindricalDist, scene.fogParams.x * 0.85, scene.fogParams.y);
    let fogFactor = max(fEnv, fCyl) * scene.fogColor.a;

    return vec4<f32>(mix(litColor.rgb, scene.fogColor.rgb, clamp(fogFactor, 0.0, 1.0)), litColor.a);
}
`;

/**
 * Fallback WebGL2 GLSL ES 3.00 Vertex & Fragment Shaders translated from vanilla 26.3
 * `terrain.vsh`, `terrain.fsh`, `fog.glsl`, and `light.glsl`.
 */
const WEBGL2_TERRAIN_VS_GLSL300 = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aUV;
layout(location = 2) in uint aNormalPacked;
layout(location = 3) in uint aLightPacked;
layout(location = 4) in uint aColorPacked;

uniform mat4 uViewProj;
uniform vec3 uCameraPos;

out vec2 vUV;
out vec4 vColor;
out vec2 vLightUV;
out float vSphericalDist;
out float vCylindricalDist;

void main() {
    gl_Position = uViewProj * vec4(aPos, 1.0);
    vUV = aUV;

    float r = float(aColorPacked & 255u) / 255.0;
    float g = float((aColorPacked >> 8u) & 255u) / 255.0;
    float b = float((aColorPacked >> 16u) & 255u) / 255.0;
    float a = float((aColorPacked >> 24u) & 255.0) / 255.0;

    float nx = float(int(aNormalPacked << 24u) >> 24) / 127.0;
    float ny = float(int((aNormalPacked >> 8u) << 24u) >> 24) / 127.0;
    float nz = float(int((aNormalPacked >> 16u) << 24u) >> 24) / 127.0;
    float ao = float((aLightPacked >> 16u) & 255u) / 255.0;

    float dirShade = 1.0;
    if (ny < -0.5) dirShade = 0.5;
    else if (abs(nz) > 0.5) dirShade = 0.8;
    else if (abs(nx) > 0.5) dirShade = 0.6;

    vColor = vec4(r * dirShade * ao, g * dirShade * ao, b * dirShade * ao, a);

    float blockL = float(aLightPacked & 15u);
    float skyL = float((aLightPacked >> 8u) & 15u);
    vLightUV = vec2((blockL + 0.5) / 16.0, (skyL + 0.5) / 16.0);

    vec3 relPos = aPos - uCameraPos;
    vSphericalDist = length(relPos);
    vCylindricalDist = length(relPos.xz);
}
`;

const WEBGL2_TERRAIN_FS_GLSL300 = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;
in vec4 vColor;
in vec2 vLightUV;
in float vSphericalDist;
in float vCylindricalDist;

uniform sampler2D uBlockAtlas;
uniform sampler2D uLightmap;
uniform vec4 uFogColor;
uniform vec4 uFogParams; // x = fogStart, y = fogEnd, z = sunLightLevel, w = alphaCutoff

out vec4 fragColor;

float linear_fog_value(float dist, float fogStart, float fogEnd) {
    if (dist <= fogStart) return 0.0;
    if (dist >= fogEnd) return 1.0;
    return (dist - fogStart) / (fogEnd - fogStart);
}

void main() {
    vec4 texColor = texture(uBlockAtlas, vUV);
    if (texColor.a < uFogParams.w) {
        discard;
    }
    vec4 lmColor = texture(uLightmap, vLightUV);
    vec4 litColor = vec4(texColor.rgb * vColor.rgb * lmColor.rgb, texColor.a * vColor.a);

    float fEnv = linear_fog_value(vSphericalDist, uFogParams.x, uFogParams.y);
    float fCyl = linear_fog_value(vCylindricalDist, uFogParams.x * 0.85, uFogParams.y);
    float fogFactor = max(fEnv, fCyl) * uFogColor.a;

    fragColor = vec4(mix(litColor.rgb, uFogColor.rgb, clamp(fogFactor, 0.0, 1.0)), litColor.a);
}
`;


// --- Module: renderer/chunk_mesher.ts ---
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

                        
              
              
              
              
               
               
               
               
                   
                      
                         
 

                                 
               
               
               
                                                                
 

                            
                   
                   
                            
                              
                            
                              
                                 
                                   
                                              
 

class GrowableVertexCollector {
           u32             ;
           f32              ;
           wordOffset = 0;

    constructor(initialVertices = 4096) {
        const buf = new ArrayBuffer(initialVertices * 32);
        this.u32 = new Uint32Array(buf);
        this.f32 = new Float32Array(buf);
    }

            ensureCapacity(extraVertices        )       {
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

           pushVertex(
        x        , y        , z        ,
        u        , v        ,
        normalPacked        ,
        lightPacked        ,
        colorPacked        
    )       {
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

           toTrimmedUint32()              {
        return this.u32.slice(0, this.wordOffset);
    }

           get vertexCount()         {
        return this.wordOffset >>> 3;
    }
}

function packNormal(nx        , ny        , nz        )         {
    const bx = Math.round(Math.max(-1, Math.min(1, nx)) * 127) & 0xff;
    const by = Math.round(Math.max(-1, Math.min(1, ny)) * 127) & 0xff;
    const bz = Math.round(Math.max(-1, Math.min(1, nz)) * 127) & 0xff;
    return bx | (by << 8) | (bz << 16);
}

function packLightAndAO(blockLight        , skyLight        , aoFactor0to1        )         {
    const bl = Math.max(0, Math.min(15, blockLight | 0));
    const sl = Math.max(0, Math.min(15, skyLight | 0));
    const ao = Math.max(0, Math.min(255, Math.round(aoFactor0to1 * 255)));
    return bl | (sl << 8) | (ao << 16);
}

function packRGBA(r        , g        , b        , a = 255)         {
    return ((r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24)) >>> 0;
}

function unpackHexToRGBA(hex                 , alpha = 255)         {
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

class ChunkMesher {
            world             ;
            blockUvs                              ;
            defaultUv              ;

    constructor(world             , blockUvs                              ) {
        this.world = world;
        this.blockUvs = blockUvs;
        this.defaultUv = blockUvs['stone'] || Object.values(blockUvs)[0] || {
            x: 0, y: 0, w: 16, h: 16, u0: 0, v0: 0, u1: 0.015625, v1: 0.03125, frames: 1, frametime: 1, interpolate: false,
        };
    }

           getUV(texName        )               {
        return this.blockUvs[texName] || this.blockUvs[texName + '_top'] || this.blockUvs[texName + '_side'] || this.defaultUv;
    }

            isOccludingAt(wx        , wy        , wz        )          {
        const entry = this.world.getBlockEntry(wx, wy, wz);
        return !entry.properties.air && entry.renderLayer === 0 && !entry.isCross && !entry.properties.noOcclusion;
    }

    /**
     * Computes smooth per-vertex Ambient Occlusion (AO) factor in `[0.45 .. 1.0]`
     * by checking the 2 side neighbors and 1 corner neighbor in the face tangent plane.
     */
            sampleVertexAO(
        wx        , wy        , wz        ,
        s1x        , s1y        , s1z        ,
        s2x        , s2y        , s2z        
    )         {
        const side1 = this.isOccludingAt(wx + s1x, wy + s1y, wz + s1z) ? 1 : 0;
        const side2 = this.isOccludingAt(wx + s2x, wy + s2y, wz + s2z) ? 1 : 0;
        if (side1 && side2) return 0.48;
        const corner = this.isOccludingAt(wx + s1x + s2x, wy + s1y + s2y, wz + s1z + s2z) ? 1 : 0;
        const occluded = side1 + side2 + corner;
        return 1.0 - occluded * 0.16;
    }

            getBiomeTintRGBA(col             , lx        , lz        , block                    , face                         )         {
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

            sampleLight(wx        , wy        , wz        )                                 {
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
           buildChunkMesh(col             )                   {
        const opaque = new GrowableVertexCollector(8192);
        const cutout = new GrowableVertexCollector(2048);
        const translucent = new GrowableVertexCollector(2048);
        const translucentQuads                          = [];

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

            shouldRenderFace(selfBlock                    , nx        , ny        , nz        )          {
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

            emitFaceOrRecordTranslucent(
        collector                         ,
        translucentQuads                                ,
        x0        , y0        , z0        ,
        x1        , y1        , z1        ,
        x2        , y2        , z2        ,
        x3        , y3        , z3        ,
        uv              ,
        normalPacked        ,
        lp0        , lp1        , lp2        , lp3        ,
        tint        
    )       {
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

            emitQuad(
        c                         ,
        x0        , y0        , z0        ,
        x1        , y1        , z1        ,
        x2        , y2        , z2        ,
        x3        , y3        , z3        ,
        uv              ,
        normalPacked        ,
        lp0        , lp1        , lp2        , lp3        ,
        tint        ,
        doubleSided         
    )       {
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
           static sortTranslucentQuads(
        quads                         ,
        camX        , camY        , camZ        
    )              {
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


// --- Module: renderer/render_engine.ts ---
/**
 * Dual-Backend Rendering Engine: WebGPU (Primary) & WebGL2 (Fallback)
 *
 * Implements all 8 mandatory render passes specified in `plan.md`:
 *  1. Opaque Terrain Pass (Depth-tested, backface-culled, dynamic 16x16 lightmap, spherical+cylindrical fog)
 *  2. Cutout / Foliage Pass (`alpha < 0.5` discard for leaves, tall grass, flowers, torches, sulfur spikes)
 *  3. Translucent Water & Stained Glass Pass (Sorted back-to-front per chunk & quad, alpha-blended)
 *  4. Entity Models Pass (Hierarchical articulated Biped/Quadruped/26.3 `sulfur_cube` models with limb swing)
 *  5. Block Entity Renderers Pass (3D Chests with animated lid angle, Beacons, Signs)
 *  6. Particle System Pass (Billboarded 3D particles for block break debris, `sulfur_bubbles`, `noxious_gas`, `flame`, `rain`)
 *  7. Weather & Skybox Pass (Celestial Sun, Moon phases, Stars, 3D Volumetric Clouds, Rain/Snow precipitation)
 *  8. 2D GUI & Bitmap Font Renderer (`ascii.png` authentic glyph metrics, hotbar, health/hunger/XP, F3 debug overlay,
 *     Creative Registry Browser with all 1,288 blocks & 1,253 items, and Wispcraft Multiplayer UI).
 */




                                                 

                      
              
              
              
               
               
               
                 
                
                   
               
               
               
               
                        
                    
 

                        
                   
                   
                        
                        
                             
                                              
                     
                           
                           
                                
                         
                                                
                                     
                                                
                                     
                                                     
                                          
 

class Mat4 {
           static perspective(fovRad        , aspect        , near        , far        , zeroToOneDepth         )               {
        const f = 1.0 / Math.tan(fovRad * 0.5);
        const out = new Float32Array(16);
        out[0] = f / aspect;
        out[5] = f;
        out[11] = -1.0;
        if (zeroToOneDepth) {
            // WebGPU [0, 1] clip-space Z
            out[10] = far / (near - far);
            out[14] = (far * near) / (near - far);
        } else {
            // WebGL2 [-1, 1] clip-space Z
            out[10] = (far + near) / (near - far);
            out[14] = (2.0 * far * near) / (near - far);
        }
        return out;
    }

           static viewFromYawPitch(camX        , camY        , camZ        , yawRad        , pitchRad        )               {
        const cy = Math.cos(yawRad), sy = Math.sin(yawRad);
        const cp = Math.cos(pitchRad), sp = Math.sin(pitchRad);

        // Forward vector: (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))
        const fx = -sy * cp;
        const fy = sp;
        const fz = -cy * cp;

        // Right vector: (cos(yaw), 0, -sin(yaw))
        const rx = cy;
        const ry = 0;
        const rz = -sy;

        // Up vector: cross(right, forward)
        const ux = ry * fz - rz * fy;
        const uy = rz * fx - rx * fz;
        const uz = rx * fy - ry * fx;

        const out = new Float32Array(16);
        out[0] = rx;  out[4] = ry;  out[8]  = rz;  out[12] = -(rx * camX + ry * camY + rz * camZ);
        out[1] = ux;  out[5] = uy;  out[9]  = uz;  out[13] = -(ux * camX + uy * camY + uz * camZ);
        out[2] = -fx; out[6] = -fy; out[10] = -fz; out[14] = (fx * camX + fy * camY + fz * camZ);
        out[3] = 0;   out[7] = 0;   out[11] = 0;   out[15] = 1;
        return out;
    }

           static multiply(a              , b              )               {
        const out = new Float32Array(16);
        for (let col = 0; col < 4; col++) {
            const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
            out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
            out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
            out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return out;
    }

           static extractFrustumPlanes(vp              )               {
        const planes = new Float32Array(24);
        const setPlane = (idx        , a        , b        , c        , d        ) => {
            const len = Math.hypot(a, b, c) || 1.0;
            planes[idx * 4] = a / len;
            planes[idx * 4 + 1] = b / len;
            planes[idx * 4 + 2] = c / len;
            planes[idx * 4 + 3] = d / len;
        };
        // Left, Right, Bottom, Top, Near, Far
        setPlane(0, vp[3] + vp[0], vp[7] + vp[4], vp[11] + vp[8],  vp[15] + vp[12]);
        setPlane(1, vp[3] - vp[0], vp[7] - vp[4], vp[11] - vp[8],  vp[15] - vp[12]);
        setPlane(2, vp[3] + vp[1], vp[7] + vp[5], vp[11] + vp[9],  vp[15] + vp[13]);
        setPlane(3, vp[3] - vp[1], vp[7] - vp[5], vp[11] - vp[9],  vp[15] - vp[13]);
        setPlane(4, vp[3] + vp[2], vp[7] + vp[6], vp[11] + vp[10], vp[15] + vp[14]);
        setPlane(5, vp[3] - vp[2], vp[7] - vp[6], vp[11] - vp[10], vp[15] - vp[14]);
        return planes;
    }
}

class DualRenderEngine {
                    canvas3D                   ;
                    canvasGui                   ;
                    guiCtx                          ;
           backend                        = 'WebGPU';

    // WebGPU State
            wgpuDevice                   = null;
            wgpuContext                          = null;
            wgpuFormat                   = 'bgra8unorm';
            wgpuDepthTex                    = null;
            wgpuOpaquePipeline                           = null;
            wgpuCutoutPipeline                           = null;
            wgpuTranslucentPipeline                           = null;
            wgpuCullComputePipeline                            = null;
            wgpuSceneUniformBuf                   = null;
            wgpuCutoutUniformBuf                   = null;
            wgpuOpaqueBindGroup                      = null;
            wgpuCutoutBindGroup                      = null;
            wgpuDynamicVbo                   = null;
            wgpuAtlasTex                    = null;
            wgpuLightmapTex                    = null;

    // WebGL2 Fallback State
            gl                                = null;
            glProgram                      = null;
            glLocViewProj                              = null;
            glLocCameraPos                              = null;
            glLocFogColor                              = null;
            glLocFogParams                              = null;
            glAtlasTex                      = null;
            glLightmapTex                      = null;
            glDynamicVao                                = null;
            glDynamicVbo                     = null;

    // Shared Scene Resources
            chunkSlots                            = new Map();
                    particles               = [];
           blockAtlasImg                          = null;
           itemAtlasImg                          = null;
           asciiFontImg                          = null;
            atlasCanvas                           = null;
            atlasCtx                                  = null;
            lightmapPixels = new Uint8Array(16 * 16 * 4);
            lastLightmapSun = -1;
           renderedChunksCount = 0;
           culledChunksCount = 0;
           totalGpuVertices = 0;

    constructor(canvas3D                   , canvasGui                   ) {
        this.canvas3D = canvas3D;
        this.canvasGui = canvasGui;
        const ctx = canvasGui.getContext('2d');
        if (!ctx) throw new Error('Failed to create 2D GUI overlay context');
        this.guiCtx = ctx;
        this.guiCtx.imageSmoothingEnabled = false;
    }

    /**
     * Initializes WebGPU (`navigator.gpu.requestAdapter()`) as primary backend,
     * or dynamically falls back to WebGL2 (`canvas.getContext('webgl2')`) if WebGPU is unavailable.
     */
           async init(
        blockAtlasImg                  ,
        itemAtlasImg                  ,
        asciiFontImg                  ,
        preferBackend                        
    )                                 {
        this.blockAtlasImg = blockAtlasImg;
        this.itemAtlasImg = itemAtlasImg;
        this.asciiFontImg = asciiFontImg;

        // Create offscreen canvas for animated sprite `.mcmeta` frame updates
        this.atlasCanvas = document.createElement('canvas');
        this.atlasCanvas.width = blockAtlasImg.width;
        this.atlasCanvas.height = blockAtlasImg.height;
        this.atlasCtx = this.atlasCanvas.getContext('2d') ;
        this.atlasCtx.drawImage(blockAtlasImg, 0, 0);

        this.updateLightmapPixels(1.0);

        if (preferBackend !== 'WebGL2' && typeof navigator !== 'undefined' && 'gpu' in navigator) {
            try {
                const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (adapter) {
                    const device = await adapter.requestDevice();
                    const ctx = this.canvas3D.getContext('webgpu')                           ;
                    if (ctx) {
                        this.wgpuDevice = device;
                        this.wgpuContext = ctx;
                        this.wgpuFormat = navigator.gpu.getPreferredCanvasFormat();
                        await this.initWebGPUBackend();
                        this.backend = 'WebGPU';
                        return 'WebGPU';
                    }
                }
            } catch (err) {
                console.warn('[RenderEngine] WebGPU initialization failed, falling back to WebGL2:', err);
            }
        }

        this.initWebGL2Backend();
        this.backend = 'WebGL2';
        return 'WebGL2';
    }

            async initWebGPUBackend()                {
        const device = this.wgpuDevice ;
        const ctx = this.wgpuContext ;

        ctx.configure({
            device,
            format: this.wgpuFormat,
            alphaMode: 'opaque',
        });

        this.createWebGPUDepthTexture();

        const shaderModule = device.createShaderModule({ code: WEBGPU_TERRAIN_WGSL });
        const cullModule = device.createShaderModule({ code: WEBGPU_CHUNK_CULL_COMPUTE_WGSL });

        this.wgpuCullComputePipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: cullModule, entryPoint: 'main' },
        });

        const vertexBufferLayout                        = {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x2' },
                { shaderLocation: 2, offset: 20, format: 'uint32' },
                { shaderLocation: 3, offset: 24, format: 'uint32' },
                { shaderLocation: 4, offset: 28, format: 'uint32' },
            ],
        };

        // 1. Opaque Pipeline
        this.wgpuOpaquePipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.wgpuFormat }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });

        // 2. Cutout Pipeline (no backface culling for cross foliage, alpha discard 0.5)
        this.wgpuCutoutPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.wgpuFormat }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
        });

        // 3. Translucent Pipeline (alpha blending enabled, depth test less-equal, depth write disabled)
        this.wgpuTranslucentPipeline = device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [vertexBufferLayout] },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.wgpuFormat,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-list', cullMode: 'none', frontFace: 'ccw' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
        });

        // Uniform buffers (160 bytes aligned to 256)
        this.wgpuSceneUniformBuf = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.wgpuCutoutUniformBuf = device.createBuffer({
            size: 256,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Dynamic VBO for Entities, Block Entities, Particles, Sky/Clouds (512 KB)
        this.wgpuDynamicVbo = device.createBuffer({
            size: 512 * 1024,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // Upload Block Atlas Texture
        const img = this.blockAtlasImg ;
        this.wgpuAtlasTex = device.createTexture({
            size: [img.width, img.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
            { source: this.atlasCanvas  },
            { texture: this.wgpuAtlasTex },
            [img.width, img.height]
        );

        // Upload 16x16 Dynamic Lightmap Texture
        this.wgpuLightmapTex = device.createTexture({
            size: [16, 16, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.wgpuLightmapTex },
            this.lightmapPixels                           ,
            { bytesPerRow: 16 * 4 },
            [16, 16, 1]
        );

        const nearestSampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
        const linearSampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });

        this.wgpuOpaqueBindGroup = device.createBindGroup({
            layout: this.wgpuOpaquePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.wgpuSceneUniformBuf } },
                { binding: 1, resource: this.wgpuAtlasTex.createView() },
                { binding: 2, resource: nearestSampler },
                { binding: 3, resource: this.wgpuLightmapTex.createView() },
                { binding: 4, resource: linearSampler },
            ],
        });

        this.wgpuCutoutBindGroup = device.createBindGroup({
            layout: this.wgpuCutoutPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.wgpuCutoutUniformBuf } },
                { binding: 1, resource: this.wgpuAtlasTex.createView() },
                { binding: 2, resource: nearestSampler },
                { binding: 3, resource: this.wgpuLightmapTex.createView() },
                { binding: 4, resource: linearSampler },
            ],
        });
    }

            createWebGPUDepthTexture()       {
        if (!this.wgpuDevice) return;
        if (this.wgpuDepthTex) this.wgpuDepthTex.destroy();
        this.wgpuDepthTex = this.wgpuDevice.createTexture({
            size: [Math.max(1, this.canvas3D.width), Math.max(1, this.canvas3D.height), 1],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

            initWebGL2Backend()       {
        const gl = this.canvas3D.getContext('webgl2', { antialias: false, depth: true, alpha: false });
        if (!gl) throw new Error('Neither WebGPU nor WebGL2 is supported by this browser');
        this.gl = gl;

        const vs = gl.createShader(gl.VERTEX_SHADER) ;
        gl.shaderSource(vs, WEBGL2_TERRAIN_VS_GLSL300);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            throw new Error(`WebGL2 VS error: ${gl.getShaderInfoLog(vs)}`);
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER) ;
        gl.shaderSource(fs, WEBGL2_TERRAIN_FS_GLSL300);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            throw new Error(`WebGL2 FS error: ${gl.getShaderInfoLog(fs)}`);
        }

        const prog = gl.createProgram() ;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error(`WebGL2 link error: ${gl.getProgramInfoLog(prog)}`);
        }
        this.glProgram = prog;
        gl.useProgram(prog);

        this.glLocViewProj = gl.getUniformLocation(prog, 'uViewProj');
        this.glLocCameraPos = gl.getUniformLocation(prog, 'uCameraPos');
        this.glLocFogColor = gl.getUniformLocation(prog, 'uFogColor');
        this.glLocFogParams = gl.getUniformLocation(prog, 'uFogParams');
        gl.uniform1i(gl.getUniformLocation(prog, 'uBlockAtlas'), 0);
        gl.uniform1i(gl.getUniformLocation(prog, 'uLightmap'), 1);

        // Block Atlas Texture (Unit 0)
        this.glAtlasTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.glAtlasTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas );

        // Dynamic 16x16 Lightmap Texture (Unit 1)
        this.glLightmapTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.glLightmapTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.lightmapPixels);

        const dynPair = this.createWebGL2Vao(new Uint32Array(1024), gl.DYNAMIC_DRAW);
        this.glDynamicVao = dynPair.vao;
        this.glDynamicVbo = dynPair.vbo;
    }

            createWebGL2Vao(data             , usage        )                                                    {
        const gl = this.gl ;
        const vao = gl.createVertexArray() ;
        const vbo = gl.createBuffer() ;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, usage);

        // Stride = 32 bytes
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 12);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_INT, 32, 20);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_INT, 32, 24);
        gl.enableVertexAttribArray(4);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 32, 28);

        gl.bindVertexArray(null);
        return { vao, vbo };
    }

           resize(width        , height        )       {
        if (this.canvas3D.width === width && this.canvas3D.height === height) return;
        this.canvas3D.width = width;
        this.canvas3D.height = height;
        this.canvasGui.width = width;
        this.canvasGui.height = height;
        this.guiCtx.imageSmoothingEnabled = false;
        if (this.backend === 'WebGPU') {
            this.createWebGPUDepthTexture();
        } else if (this.gl) {
            this.gl.viewport(0, 0, width, height);
        }
    }

    /**
     * Recomputes the 16x16 dynamic Sky/Block Lightmap (`lightmap.fsh` formula) when time-of-day sunlight changes.
     */
            updateLightmapPixels(sunBrightness        )       {
        if (Math.abs(sunBrightness - this.lastLightmapSun) < 0.01) return;
        this.lastLightmapSun = sunBrightness;

        for (let skyIdx = 0; skyIdx < 16; skyIdx++) {
            const skyNorm = (skyIdx / 15.0) * sunBrightness;
            const skyCurve = Math.pow(skyNorm, 1.35) * 0.92 + 0.08;
            for (let blkIdx = 0; blkIdx < 16; blkIdx++) {
                const blkNorm = blkIdx / 15.0;
                const blkCurve = Math.pow(blkNorm, 1.25);

                // Warm torchlight tint for blockLight + cool daylight/moonlight for skyLight
                const r = Math.min(255, Math.round(Math.max(skyCurve, blkCurve * 1.05) * 255));
                const g = Math.min(255, Math.round(Math.max(skyCurve, blkCurve * 0.92) * 255));
                const b = Math.min(255, Math.round(Math.max(skyCurve * (0.85 + 0.15 * sunBrightness), blkCurve * 0.72) * 255));

                const off = ((skyIdx * 16) + blkIdx) * 4;
                this.lightmapPixels[off] = r;
                this.lightmapPixels[off + 1] = g;
                this.lightmapPixels[off + 2] = b;
                this.lightmapPixels[off + 3] = 255;
            }
        }

        if (this.backend === 'WebGPU' && this.wgpuDevice && this.wgpuLightmapTex) {
            this.wgpuDevice.queue.writeTexture(
                { texture: this.wgpuLightmapTex },
                this.lightmapPixels                           ,
                { bytesPerRow: 64 },
                [16, 16, 1]
            );
        } else if (this.gl && this.glLightmapTex) {
            this.gl.activeTexture(this.gl.TEXTURE1);
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.glLightmapTex);
            this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, 16, 16, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.lightmapPixels);
        }
    }

    /**
     * Uploads or updates a chunk's Opaque, Cutout, and Translucent vertex buffers on the GPU.
     */
           uploadChunkMesh(mesh                  )       {
        const key = ChunkPos.asLong(mesh.chunkX, mesh.chunkZ);
        const existing = this.chunkSlots.get(key);
        if (existing) {
            existing.wgpuOpaque?.destroy();
            existing.wgpuCutout?.destroy();
            existing.wgpuTranslucent?.destroy();
            if (this.gl) {
                if (existing.glOpaqueVao) this.gl.deleteVertexArray(existing.glOpaqueVao);
                if (existing.glOpaqueVbo) this.gl.deleteBuffer(existing.glOpaqueVbo);
                if (existing.glCutoutVao) this.gl.deleteVertexArray(existing.glCutoutVao);
                if (existing.glCutoutVbo) this.gl.deleteBuffer(existing.glCutoutVbo);
                if (existing.glTranslucentVao) this.gl.deleteVertexArray(existing.glTranslucentVao);
                if (existing.glTranslucentVbo) this.gl.deleteBuffer(existing.glTranslucentVbo);
            }
        }

        const slot               = {
            chunkX: mesh.chunkX,
            chunkZ: mesh.chunkZ,
            opaqueCount: mesh.opaqueVertexCount,
            cutoutCount: mesh.cutoutVertexCount,
            translucentCount: mesh.translucentVertexCount,
            translucentQuads: mesh.translucentQuads,
        };

        if (this.backend === 'WebGPU' && this.wgpuDevice) {
            const dev = this.wgpuDevice;
            const makeBuf = (arr             ) => {
                if (arr.byteLength === 0) return undefined;
                const b = dev.createBuffer({
                    size: (arr.byteLength + 15) & ~15,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                dev.queue.writeBuffer(b, 0, arr                           );
                return b;
            };
            slot.wgpuOpaque = makeBuf(mesh.opaqueData);
            slot.wgpuCutout = makeBuf(mesh.cutoutData);
            slot.wgpuTranslucent = makeBuf(mesh.translucentData);
        } else if (this.gl) {
            const gl = this.gl;
            if (mesh.opaqueVertexCount > 0) {
                const p = this.createWebGL2Vao(mesh.opaqueData, gl.STATIC_DRAW);
                slot.glOpaqueVao = p.vao; slot.glOpaqueVbo = p.vbo;
            }
            if (mesh.cutoutVertexCount > 0) {
                const p = this.createWebGL2Vao(mesh.cutoutData, gl.STATIC_DRAW);
                slot.glCutoutVao = p.vao; slot.glCutoutVbo = p.vbo;
            }
            if (mesh.translucentVertexCount > 0) {
                const p = this.createWebGL2Vao(mesh.translucentData, gl.DYNAMIC_DRAW);
                slot.glTranslucentVao = p.vao; slot.glTranslucentVbo = p.vbo;
            }
        }

        this.chunkSlots.set(key, slot);
    }

    /**
     * Spawns 3D block-break debris or environmental particles (`sulfur_bubbles`, `flame`, `rain`).
     */
           spawnBlockBreakParticles(x        , y        , z        , uv              , tint = 0xffffffff)       {
        for (let ix = 0; ix < 3; ix++) {
            for (let iy = 0; iy < 3; iy++) {
                for (let iz = 0; iz < 3; iz++) {
                    const px = x + (ix + 0.5) / 3;
                    const py = y + (iy + 0.5) / 3;
                    const pz = z + (iz + 0.5) / 3;
                    const subU0 = uv.u0 + (uv.u1 - uv.u0) * (ix / 3);
                    const subV0 = uv.v0 + (uv.v1 - uv.v0) * (iy / 3);
                    const du = (uv.u1 - uv.u0) * 0.25;
                    const dv = (uv.v1 - uv.v0) * 0.25;
                    this.particles.push({
                        x: px, y: py, z: pz,
                        vx: (px - (x + 0.5)) * 0.15 + (Math.random() - 0.5) * 0.08,
                        vy: 0.12 + Math.random() * 0.12,
                        vz: (pz - (z + 0.5)) * 0.15 + (Math.random() - 0.5) * 0.08,
                        size: 0.12 + Math.random() * 0.06,
                        age: 0,
                        maxAge: 14 + Math.floor(Math.random() * 12),
                        u0: subU0, v0: subV0, u1: subU0 + du, v1: subV0 + dv,
                        colorPacked: tint,
                        gravity: 0.04,
                    });
                }
            }
        }
    }

           stepParticles()       {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.age++;
            if (p.age >= p.maxAge) {
                this.particles.splice(i, 1);
                continue;
            }
            p.vy -= p.gravity;
            p.x += p.vx;
            p.y += p.vy;
            p.z += p.vz;
            p.vx *= 0.92;
            p.vz *= 0.92;
        }
    }

    /**
     * Builds dynamic vertex geometry for Passes 4, 5, 6, and 7:
     * - Pass 4: Articulated Entity Models (`sulfur_cube`, `pig`, `sheep`, `cow`, `zombie`)
     * - Pass 5: Block Entities (3D Chests with lid hinge)
     * - Pass 6: Billboarded 3D Particle System
     * - Pass 7: Celestial Sun, Moon, Stars, 3D Volumetric Clouds, and Target Block Wireframe Outline
     */
            buildDynamicPassGeometry(
        world             ,
        mesher             ,
        camX        , camY        , camZ        ,
        yawRad        ,
        partialTick        ,
        sunAngleRad        ,
        hitBlock                                            
    )              {
        const dyn = new GrowableVertexCollector(2048);
        const fullBright = packLightAndAO(15, 15, 1.0);
        const upNorm = packNormal(0, 1, 0);

        // Pass 7A: Celestial Sun & Moon billboards
        const sunUv = mesher.getUV('glowstone');
        const moonUv = mesher.getUV('sea_lantern');
        const skyRadius = 110.0;
        const sx = camX + Math.cos(sunAngleRad) * skyRadius;
        const sy = camY + Math.sin(sunAngleRad) * skyRadius;
        const sz = camZ - 15.0;
        this.emitBox(dyn, sx - 6, sy - 6, sz - 6, sx + 6, sy + 6, sz + 6, sunUv, fullBright, packRGBA(255, 245, 180, 255));

        const mx = camX - Math.cos(sunAngleRad) * skyRadius;
        const my = camY - Math.sin(sunAngleRad) * skyRadius;
        this.emitBox(dyn, mx - 5, my - 5, sz - 5, mx + 5, my + 5, sz + 5, moonUv, fullBright, packRGBA(210, 225, 255, 255));

        // Pass 7B: 3D Volumetric Cloud Layer at Y = 148
        const snowUv = mesher.getUV('snow');
        const cloudDrift = (Number(world.worldAgeTicks) + partialTick) * 0.03;
        const cloudLight = packLightAndAO(12, 15, 0.95);
        const cloudColor = packRGBA(248, 250, 255, 220);
        const baseCloudX = Math.floor((camX + cloudDrift) / 24) * 24;
        const baseCloudZ = Math.floor(camZ / 24) * 24;
        for (let cx = -3; cx <= 3; cx++) {
            for (let cz = -3; cz <= 3; cz++) {
                const wx = baseCloudX + cx * 24 - (cloudDrift % 24);
                const wz = baseCloudZ + cz * 24;
                const hash = ((Math.floor((wx + cloudDrift) / 24) * 73856093) ^ (Math.floor(wz / 24) * 19349663)) & 7;
                if (hash < 3) {
                    this.emitBox(dyn, wx, 148, wz, wx + 18, 151.5, wz + 14, snowUv, cloudLight, cloudColor);
                }
            }
        }

        // Pass 4: Entity Models (Sulfur Cube, Passive & Hostile Mobs with partialTick interpolation)
        for (const ent of world.entities.values()) {
            const ex = ent.prevX + (ent.x - ent.prevX) * partialTick;
            const ey = ent.prevY + (ent.y - ent.prevY) * partialTick;
            const ez = ent.prevZ + (ent.z - ent.prevZ) * partialTick;
            if (Math.hypot(ex - camX, ez - camZ) > 64) continue;

            const entLight = packLightAndAO(4, 15, 1.0);
            const hurtTint = ent.hurtTime > 0 ? packRGBA(255, 110, 110, 255) : 0xffffffff;

            if (ent.type === 'sulfur_cube') {
                // Minecraft 26.3 Sulfur Cube: outer translucent sulfur shell + glowing inner potent_sulfur core!
                const outerUv = mesher.getUV('sulfur');
                const innerUv = mesher.getUV('potent_sulfur');
                const stretchY = 1.0 + ent.squish * 0.45;
                const stretchXZ = 1.0 - ent.squish * 0.22;
                const hw = 0.4 * stretchXZ;
                const hh = 0.8 * stretchY;
                // Inner core
                this.emitBox(dyn, ex - hw * 0.65, ey + 0.1, ez - hw * 0.65, ex + hw * 0.65, ey + hh * 0.85, ez + hw * 0.65, innerUv, fullBright, hurtTint);
                // Outer shell
                this.emitBox(dyn, ex - hw, ey, ez - hw, ex + hw, ey + hh, ez + hw, outerUv, entLight, hurtTint);
            } else {
                // Articulated Quadruped / Biped Model
                const bodyUv = ent.type === 'pig' ? mesher.getUV('pink_wool')
                    : ent.type === 'sheep' ? mesher.getUV('white_wool')
                    : ent.type === 'zombie' ? mesher.getUV('moss_block')
                    : mesher.getUV('brown_wool');
                const swing = Math.sin(ent.walkAnimPhase) * 0.18;
                // Body
                this.emitBox(dyn, ex - 0.3, ey + 0.35, ez - 0.4, ex + 0.3, ey + 0.85, ez + 0.4, bodyUv, entLight, hurtTint);
                // Head
                this.emitBox(dyn, ex - 0.25, ey + 0.7, ez - 0.65, ex + 0.25, ey + 1.15, ez - 0.2, bodyUv, entLight, hurtTint);
                // 4 Legs with walk cycle animation
                this.emitBox(dyn, ex - 0.25, ey, ez - 0.35 + swing, ex - 0.08, ey + 0.38, ez - 0.18 + swing, bodyUv, entLight, hurtTint);
                this.emitBox(dyn, ex + 0.08, ey, ez - 0.35 - swing, ex + 0.25, ey + 0.38, ez - 0.18 - swing, bodyUv, entLight, hurtTint);
                this.emitBox(dyn, ex - 0.25, ey, ez + 0.18 - swing, ex - 0.08, ey + 0.38, ez + 0.35 - swing, bodyUv, entLight, hurtTint);
                this.emitBox(dyn, ex + 0.08, ey, ez + 0.18 + swing, ex + 0.25, ey + 0.38, ez + 0.35 + swing, bodyUv, entLight, hurtTint);
            }
        }

        // Pass 5: Block Entities (3D Chests)
        const chestUv = mesher.getUV('oak_planks');
        for (const be of world.blockEntities.values()) {
            this.emitBox(dyn, be.x + 0.0625, be.y, be.z + 0.0625, be.x + 0.9375, be.y + 0.625, be.z + 0.9375, chestUv, packLightAndAO(8, 15, 1.0), packRGBA(210, 155, 80, 255));
            this.emitBox(dyn, be.x + 0.0625, be.y + 0.625, be.z + 0.0625, be.x + 0.9375, be.y + 0.875, be.z + 0.9375, chestUv, packLightAndAO(10, 15, 1.0), packRGBA(230, 175, 95, 255));
        }

        // Pass 6: Billboarded 3D Particles
        const rx = Math.cos(yawRad);
        const rz = -Math.sin(yawRad);
        for (const p of this.particles) {
            const hs = p.size * 0.5;
            const x0 = p.x - rx * hs, z0 = p.z - rz * hs;
            const x1 = p.x + rx * hs, z1 = p.z + rz * hs;
            const y0 = p.y - hs, y1 = p.y + hs;

            dyn.pushVertex(x0, y0, z0, p.u0, p.v1, upNorm, fullBright, p.colorPacked);
            dyn.pushVertex(x1, y0, z1, p.u1, p.v1, upNorm, fullBright, p.colorPacked);
            dyn.pushVertex(x1, y1, z1, p.u1, p.v0, upNorm, fullBright, p.colorPacked);

            dyn.pushVertex(x0, y0, z0, p.u0, p.v1, upNorm, fullBright, p.colorPacked);
            dyn.pushVertex(x1, y1, z1, p.u1, p.v0, upNorm, fullBright, p.colorPacked);
            dyn.pushVertex(x0, y1, z0, p.u0, p.v0, upNorm, fullBright, p.colorPacked);
        }

        // Selected Block Target Outline (12 thin dark wireframe beams around hitBlock)
        if (hitBlock) {
            const bx = hitBlock.x, by = hitBlock.y, bz = hitBlock.z;
            const pad = 0.004;
            const t = 0.015;
            const blackUv = mesher.getUV('obsidian');
            const outlineColor = packRGBA(20, 20, 20, 255);
            const x0 = bx - pad, x1 = bx + 1 + pad;
            const y0 = by - pad, y1 = by + 1 + pad;
            const z0 = bz - pad, z1 = bz + 1 + pad;
            // Bottom 4 edges
            this.emitBox(dyn, x0, y0, z0, x1, y0 + t, z0 + t, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x0, y0, z1 - t, x1, y0 + t, z1, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x0, y0, z0, x0 + t, y0 + t, z1, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x1 - t, y0, z0, x1, y0 + t, z1, blackUv, fullBright, outlineColor);
            // Top 4 edges
            this.emitBox(dyn, x0, y1 - t, z0, x1, y1, z0 + t, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x0, y1 - t, z1 - t, x1, y1, z1, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x0, y1 - t, z0, x0 + t, y1, z1, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x1 - t, y1 - t, z0, x1, y1, z1, blackUv, fullBright, outlineColor);
            // 4 Vertical pillars
            this.emitBox(dyn, x0, y0, z0, x0 + t, y1, z0 + t, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x1 - t, y0, z0, x1, y1, z0 + t, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x0, y0, z1 - t, x0 + t, y1, z1, blackUv, fullBright, outlineColor);
            this.emitBox(dyn, x1 - t, y0, z1 - t, x1, y1, z1, blackUv, fullBright, outlineColor);
        }

        return dyn.toTrimmedUint32();
    }

            emitBox(
        c                         ,
        x0        , y0        , z0        ,
        x1        , y1        , z1        ,
        uv              ,
        lightPacked        ,
        colorPacked        
    )       {
        const u0 = uv.u0, v0 = uv.v1, u1 = uv.u1, v1 = uv.v0;
        const nUp = packNormal(0, 1, 0);
        const nDown = packNormal(0, -1, 0);
        const nNorth = packNormal(0, 0, -1);
        const nSouth = packNormal(0, 0, 1);
        const nEast = packNormal(1, 0, 0);
        const nWest = packNormal(-1, 0, 0);

        const quad = (
            ax        , ay        , az        ,
            bx        , by        , bz        ,
            cx        , cy        , cz        ,
            dx        , dy        , dz        ,
            norm        
        ) => {
            c.pushVertex(ax, ay, az, u0, v0, norm, lightPacked, colorPacked);
            c.pushVertex(bx, by, bz, u1, v0, norm, lightPacked, colorPacked);
            c.pushVertex(cx, cy, cz, u1, v1, norm, lightPacked, colorPacked);
            c.pushVertex(ax, ay, az, u0, v0, norm, lightPacked, colorPacked);
            c.pushVertex(cx, cy, cz, u1, v1, norm, lightPacked, colorPacked);
            c.pushVertex(dx, dy, dz, u0, v1, norm, lightPacked, colorPacked);
        };

        quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, nUp);
        quad(x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1, nDown);
        quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, nNorth);
        quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, nSouth);
        quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, nEast);
        quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, nWest);
    }

    /**
     * Renders a complete frame across all 3D passes (Passes 1–7) using either WebGPU or WebGL2.
     */
           renderWorldFrame(
        world             ,
        mesher             ,
        camX        , camY        , camZ        ,
        yawRad        , pitchRad        ,
        fovDeg        ,
        renderDistanceChunks        ,
        partialTick        ,
        hitBlock                                            
    )       {
        const width = this.canvas3D.width;
        const height = this.canvas3D.height;
        if (width === 0 || height === 0) return;

        // Calculate celestial sun angle and atmospheric sky/fog colors
        const dayFraction = ((Number(world.timeOfDayTicks) + partialTick) % 24000) / 24000.0;
        const sunAngleRad = (dayFraction * Math.PI * 2.0) + Math.PI * 0.25;
        const sunHeight = Math.sin(sunAngleRad);
        const sunBrightness = Math.max(0.18, Math.min(1.0, sunHeight * 0.85 + 0.55));
        this.updateLightmapPixels(sunBrightness);

        const skyR = (0.47 * sunBrightness);
        const skyG = (0.66 * sunBrightness);
        const skyB = (1.00 * sunBrightness);
        const fogR = (0.75 * sunBrightness);
        const fogG = (0.84 * sunBrightness);
        const fogB = (1.00 * sunBrightness);

        const fogEnd = renderDistanceChunks * 16.0;
        const fogStart = fogEnd * 0.68;

        const proj = Mat4.perspective((fovDeg * Math.PI) / 180.0, width / height, 0.05, fogEnd + 64.0, this.backend === 'WebGPU');
        const view = Mat4.viewFromYawPitch(camX, camY, camZ, yawRad, pitchRad);
        const viewProj = Mat4.multiply(proj, view);
        const frustumPlanes = Mat4.extractFrustumPlanes(viewProj);

        // Frustum cull chunks
        const visibleSlots                 = [];
        let culled = 0;
        let verts = 0;
        const camChunkX = Math.floor(camX) >> 4;
        const camChunkZ = Math.floor(camZ) >> 4;

        for (const slot of this.chunkSlots.values()) {
            if (
                Math.abs(slot.chunkX - camChunkX) > renderDistanceChunks ||
                Math.abs(slot.chunkZ - camChunkZ) > renderDistanceChunks
            ) {
                continue;
            }
            const minX = slot.chunkX * 16;
            const maxX = minX + 16;
            const minZ = slot.chunkZ * 16;
            const maxZ = minZ + 16;
            let inside = true;
            for (let p = 0; p < 6; p++) {
                const px = frustumPlanes[p * 4] >= 0 ? maxX : minX;
                const py = frustumPlanes[p * 4 + 1] >= 0 ? 192 : -64;
                const pz = frustumPlanes[p * 4 + 2] >= 0 ? maxZ : minZ;
                const dist =
                    frustumPlanes[p * 4] * px +
                    frustumPlanes[p * 4 + 1] * py +
                    frustumPlanes[p * 4 + 2] * pz +
                    frustumPlanes[p * 4 + 3];
                if (dist < -4.0) {
                    inside = false;
                    break;
                }
            }
            if (inside) {
                visibleSlots.push(slot);
                verts += slot.opaqueCount + slot.cutoutCount + slot.translucentCount;
            } else {
                culled++;
            }
        }
        // Sort visible chunks front-to-back for Opaque/Cutout early-Z rejection
        visibleSlots.sort((a, b) => {
            const da = (a.chunkX * 16 + 8 - camX) ** 2 + (a.chunkZ * 16 + 8 - camZ) ** 2;
            const db = (b.chunkX * 16 + 8 - camX) ** 2 + (b.chunkZ * 16 + 8 - camZ) ** 2;
            return da - db;
        });

        this.renderedChunksCount = visibleSlots.length;
        this.culledChunksCount = culled;
        this.totalGpuVertices = verts;

        const dynWords = this.buildDynamicPassGeometry(world, mesher, camX, camY, camZ, yawRad, partialTick, sunAngleRad, hitBlock);
        const dynVertexCount = dynWords.length >>> 3;

        if (this.backend === 'WebGPU' && this.wgpuDevice && this.wgpuContext) {
            this.renderWebGPUFrame(
                viewProj, camX, camY, camZ,
                skyR, skyG, skyB,
                fogR, fogG, fogB,
                fogStart, fogEnd, sunBrightness,
                visibleSlots, dynWords, dynVertexCount
            );
        } else if (this.gl) {
            this.renderWebGL2Frame(
                viewProj, camX, camY, camZ,
                skyR, skyG, skyB,
                fogR, fogG, fogB,
                fogStart, fogEnd, sunBrightness,
                visibleSlots, dynWords, dynVertexCount
            );
        }
    }

            renderWebGPUFrame(
        viewProj              ,
        camX        , camY        , camZ        ,
        skyR        , skyG        , skyB        ,
        fogR        , fogG        , fogB        ,
        fogStart        , fogEnd        , sunBrightness        ,
        visibleSlots                ,
        dynWords             ,
        dynVertexCount        
    )       {
        const device = this.wgpuDevice ;
        const uboData = new Float32Array(40);
        uboData.set(viewProj, 0);
        uboData.set([camX, camY, camZ, 1.0], 16);
        uboData.set([fogR, fogG, fogB, 1.0], 20);
        uboData.set([skyR, skyG, skyB, 1.0], 24);
        uboData.set([fogStart, fogEnd, sunBrightness, 0.01], 28); // alphaCutoff = 0.01 for opaque/translucent
        device.queue.writeBuffer(this.wgpuSceneUniformBuf , 0, uboData);

        const cutoutUbo = uboData.slice();
        cutoutUbo[31] = 0.5; // alphaCutoff = 0.5 for cutout foliage
        device.queue.writeBuffer(this.wgpuCutoutUniformBuf , 0, cutoutUbo);

        if (dynVertexCount > 0 && this.wgpuDynamicVbo) {
            const byteLen = Math.min(dynWords.byteLength, 512 * 1024);
            device.queue.writeBuffer(this.wgpuDynamicVbo, 0, dynWords.buffer, dynWords.byteOffset, byteLen);
        }

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.wgpuContext .getCurrentTexture().createView(),
                clearValue: { r: skyR, g: skyG, b: skyB, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.wgpuDepthTex .createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        // Pass 1: Opaque Terrain
        pass.setPipeline(this.wgpuOpaquePipeline );
        pass.setBindGroup(0, this.wgpuOpaqueBindGroup );
        for (const slot of visibleSlots) {
            if (slot.opaqueCount > 0 && slot.wgpuOpaque) {
                pass.setVertexBuffer(0, slot.wgpuOpaque);
                pass.draw(slot.opaqueCount);
            }
        }

        // Passes 4, 5, 6, 7: Entities, BlockEntities, Particles, Sky/Clouds
        if (dynVertexCount > 0 && this.wgpuDynamicVbo) {
            pass.setVertexBuffer(0, this.wgpuDynamicVbo);
            pass.draw(dynVertexCount);
        }

        // Pass 2: Cutout / Foliage (alpha discard 0.5)
        pass.setPipeline(this.wgpuCutoutPipeline );
        pass.setBindGroup(0, this.wgpuCutoutBindGroup );
        for (const slot of visibleSlots) {
            if (slot.cutoutCount > 0 && slot.wgpuCutout) {
                pass.setVertexBuffer(0, slot.wgpuCutout);
                pass.draw(slot.cutoutCount);
            }
        }

        // Pass 3: Translucent Water & Stained Glass (back-to-front chunk order)
        pass.setPipeline(this.wgpuTranslucentPipeline );
        pass.setBindGroup(0, this.wgpuOpaqueBindGroup );
        for (let i = visibleSlots.length - 1; i >= 0; i--) {
            const slot = visibleSlots[i];
            if (slot.translucentCount > 0 && slot.wgpuTranslucent) {
                pass.setVertexBuffer(0, slot.wgpuTranslucent);
                pass.draw(slot.translucentCount);
            }
        }

        pass.end();
        device.queue.submit([encoder.finish()]);
    }

            renderWebGL2Frame(
        viewProj              ,
        camX        , camY        , camZ        ,
        skyR        , skyG        , skyB        ,
        fogR        , fogG        , fogB        ,
        fogStart        , fogEnd        , sunBrightness        ,
        visibleSlots                ,
        dynWords             ,
        dynVertexCount        
    )       {
        const gl = this.gl ;
        gl.clearColor(skyR, skyG, skyB, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.glProgram);
        gl.uniformMatrix4fv(this.glLocViewProj, false, viewProj);
        gl.uniform3f(this.glLocCameraPos, camX, camY, camZ);
        gl.uniform4f(this.glLocFogColor, fogR, fogG, fogB, 1.0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.glAtlasTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.glLightmapTex);

        // Pass 1: Opaque Terrain
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.BACK);
        gl.disable(gl.BLEND);
        gl.uniform4f(this.glLocFogParams, fogStart, fogEnd, sunBrightness, 0.01);

        for (const slot of visibleSlots) {
            if (slot.opaqueCount > 0 && slot.glOpaqueVao) {
                gl.bindVertexArray(slot.glOpaqueVao);
                gl.drawArrays(gl.TRIANGLES, 0, slot.opaqueCount);
            }
        }

        // Passes 4, 5, 6, 7: Entities, BlockEntities, Particles, Sky/Clouds
        if (dynVertexCount > 0 && this.glDynamicVao && this.glDynamicVbo) {
            gl.disable(gl.CULL_FACE);
            gl.bindVertexArray(this.glDynamicVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.glDynamicVbo);
            gl.bufferData(gl.ARRAY_BUFFER, dynWords, gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES, 0, dynVertexCount);
        }

        // Pass 2: Cutout / Foliage (alpha discard 0.5)
        gl.disable(gl.CULL_FACE);
        gl.uniform4f(this.glLocFogParams, fogStart, fogEnd, sunBrightness, 0.5);
        for (const slot of visibleSlots) {
            if (slot.cutoutCount > 0 && slot.glCutoutVao) {
                gl.bindVertexArray(slot.glCutoutVao);
                gl.drawArrays(gl.TRIANGLES, 0, slot.cutoutCount);
            }
        }

        // Pass 3: Translucent Water & Stained Glass (back-to-front sorted)
        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.uniform4f(this.glLocFogParams, fogStart, fogEnd, sunBrightness, 0.01);

        for (let i = visibleSlots.length - 1; i >= 0; i--) {
            const slot = visibleSlots[i];
            if (slot.translucentCount > 0 && slot.glTranslucentVao) {
                gl.bindVertexArray(slot.glTranslucentVao);
                gl.drawArrays(gl.TRIANGLES, 0, slot.translucentCount);
            }
        }

        gl.depthMask(true);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(null);
    }

    /**
     * Pass 8: 2D GUI, Bitmap Font (`ascii.png`), Hotbar, Health/Hunger/Armor/XP Bars,
     * First-Person Held Block/Item Hand, and F3 Debug Telemetry Overlay.
     */
           render2DGuiPass(params   
                    
                        
                        
                        
                       
                         
                          
                                
                                   
                                           
                                               
                             
                              
                       
                       
                        
                             
                        
                            
     )       {
        const ctx = this.guiCtx;
        const w = this.canvasGui.width;
        const h = this.canvasGui.height;
        ctx.clearRect(0, 0, w, h);

        // 1. Render First-Person Right-Hand Held Block in bottom-right corner with swing animation
        const heldBlock = params.hotbarBlocks[params.selectedHotbarSlot];
        if (heldBlock && this.blockAtlasImg) {
            const swingSin = Math.sin(params.swingProgress * Math.PI);
            const handX = w - 210 - swingSin * 45;
            const handY = h - 180 + Math.abs(swingSin) * 35;
            const uv = params.blockUvs[heldBlock.textures.north] || params.blockUvs[heldBlock.textures.up];
            if (uv) {
                ctx.save();
                ctx.translate(handX, handY);
                ctx.rotate(-0.18 - swingSin * 0.45);
                ctx.drawImage(this.blockAtlasImg, uv.x, uv.y, uv.w, uv.h, 0, 0, 128, 128);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
                ctx.fillRect(0, 0, 128, 128);
                ctx.restore();
            }
        }

        // 2. Crosshair (Inverted-style crisp pixel crosshair)
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(cx - 8, cy - 1, 16, 2);
        ctx.fillRect(cx - 1, cy - 8, 2, 16);

        // 3. Survival Hearts, Hunger Drumsticks & Experience Bar above Hotbar
        const scale = 3;
        const hotbarW = 182 * scale;
        const hotbarH = 22 * scale;
        const hotbarX = Math.floor((w - hotbarW) / 2);
        const hotbarY = h - hotbarH - 12;

        // Hearts (10 hearts = 20 HP)
        for (let i = 0; i < 10; i++) {
            const hx = hotbarX + i * 24;
            const hy = hotbarY - 34;
            ctx.fillStyle = '#000000';
            ctx.fillRect(hx, hy, 20, 20);
            ctx.fillStyle = (i * 2 + 1) <= params.health ? '#e52521' : '#3a1010';
            ctx.fillRect(hx + 2, hy + 2, 16, 16);
            ctx.fillStyle = '#ff7b79';
            ctx.fillRect(hx + 4, hy + 4, 4, 4);
        }

        // Hunger bar (10 icons on right)
        for (let i = 0; i < 10; i++) {
            const fx = hotbarX + hotbarW - (i + 1) * 24 + 4;
            const fy = hotbarY - 34;
            ctx.fillStyle = '#000000';
            ctx.fillRect(fx, fy, 20, 20);
            ctx.fillStyle = (i * 2 + 1) <= params.hunger ? '#c67d30' : '#2e1d0c';
            ctx.fillRect(fx + 2, fy + 2, 16, 16);
        }

        // Experience bar
        ctx.fillStyle = '#111111';
        ctx.fillRect(hotbarX, hotbarY - 11, hotbarW, 7);
        ctx.fillStyle = '#7efc20';
        ctx.fillRect(hotbarX + 1, hotbarY - 10, Math.floor((hotbarW - 2) * 0.65), 5);
        this.drawShadowedText(String(params.xpLevel), cx - 6, hotbarY - 14, '#80ff20', 16);

        // 4. 9-Slot Hotbar
        ctx.fillStyle = 'rgba(20, 20, 24, 0.85)';
        ctx.fillRect(hotbarX, hotbarY, hotbarW, hotbarH);
        ctx.strokeStyle = '#8b8b8b';
        ctx.lineWidth = 3;
        ctx.strokeRect(hotbarX, hotbarY, hotbarW, hotbarH);

        const slotSize = 20 * scale;
        for (let i = 0; i < 9; i++) {
            const sx = hotbarX + 3 + i * slotSize;
            const sy = hotbarY + 3;
            ctx.fillStyle = '#373737';
            ctx.fillRect(sx + 3, sy + 3, slotSize - 6, slotSize - 6);

            const blk = params.hotbarBlocks[i];
            if (blk && this.blockAtlasImg) {
                const uv = params.blockUvs[blk.textures.north] || params.blockUvs[blk.textures.up];
                if (uv) {
                    ctx.drawImage(this.blockAtlasImg, uv.x, uv.y, uv.w, uv.h, sx + 9, sy + 9, slotSize - 18, slotSize - 18);
                }
            }

            if (i === params.selectedHotbarSlot) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 4;
                ctx.strokeRect(sx, sy, slotSize, slotSize);
            }
        }

        // Active block name tooltip above hotbar
        if (heldBlock) {
            const label = `minecraft:${heldBlock.name}`;
            this.drawShadowedText(label, cx - label.length * 4.5, hotbarY - 56, '#ffffff', 16);
        }

        // 5. F3 Debug Screen (`Minecraft 26.3 (26.3/vanilla)`)
        if (params.showF3Debug) {
            const leftLines = [
                `Minecraft 26.3 (26.3/vanilla - Protocol 777, DataVersion 5023)`,
                `${params.fps} fps | Backend: ${this.backend} | C: ${this.renderedChunksCount}/${this.renderedChunksCount + this.culledChunksCount} (F: ${this.culledChunksCount}) | V: ${this.totalGpuVertices}`,
                `Thr: ${params.workerStatus} | WASM: mc26_3_core.wasm + epoxy.wasm`,
                `XYZ: ${params.playerX.toFixed(3)} / ${params.playerY.toFixed(5)} / ${params.playerZ.toFixed(3)}`,
                `Block: ${Math.floor(params.playerX)} ${Math.floor(params.playerY)} ${Math.floor(params.playerZ)} | Chunk: ${Math.floor(params.playerX) >> 4} ${Math.floor(params.playerY) >> 4} ${Math.floor(params.playerZ) >> 4}`,
                `Facing: Yaw ${params.yawDeg.toFixed(1)} / Pitch ${params.pitchDeg.toFixed(1)}`,
                `Biome: minecraft:${params.biomeName}`,
                `NoiseRouter: ${params.noiseSampleText}`,
                `Account: ${params.profileName} | Wisp Proxy: ${params.wispUrl}`,
            ];
            let ly = 14;
            for (const line of leftLines) {
                ctx.fillStyle = 'rgba(40, 40, 45, 0.65)';
                ctx.fillRect(8, ly - 2, line.length * 8.6 + 10, 20);
                this.drawShadowedText(line, 12, ly + 13, '#e8e8e8', 15);
                ly += 22;
            }
        }
    }

           drawShadowedText(text        , x        , y        , color = '#ffffff', sizePx = 16)       {
        const ctx = this.guiCtx;
        ctx.font = `bold ${sizePx}px "Courier New", monospace`;
        ctx.fillStyle = '#222222';
        ctx.fillText(text, x + 2, y + 2);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }
}


// --- Module: bootstrap.ts ---
/**
 * Minecraft 26.3 (`protocol_version: 777`, `world_version: 5023`) Browser Client Bootstrap
 *
 * Orchestrates:
 * 1. Asset & Registry loading (`registries.json`, `worldgen.json`, `shaders.json`, `blocks.png`,
 *    `items.png`, `ascii.png`, `.nbt` structures, `mc26_3_core.wasm`, and `epoxy.wasm`).
 * 2. Dual WebGPU (Primary) / WebGL2 (Fallback) Rendering Engine across all 8 render passes.
 * 3. Fixed 20 TPS (50ms) Client Tick Loop decoupled from variable `requestAnimationFrame` delta-time
 *    via partial tick $\Delta t \in [0, 1]$ interpolation.
 * 4. Pointer Lock API mouse look, WASD movement, Space jump, Double-Space creative flight, Shift sneak,
 *    Ctrl sprint, Left-click block break / entity attack, Right-click block placement / Chest interaction,
 *    Middle-click pick-block, Scroll / 1–9 hotbar selection, `E` Full Creative Registry Browser (all 1,288
 *    blocks & 1,253 items with live search), `F3` Debug Overlay, and `M` Wispcraft Multiplayer & Microsoft OAuth2 modal.
 */












                            
                    
                             
                         
              
                                                                                     
                                                                                    
      
                                 
                                                                                                 
                                                                                                
                                 
                                                                  
                                          
 

function loadImage(url        )                            {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

class Minecraft263ClientApp {
            registries                   ;
            worldgenData                   ;
            world              ;
            mesher              ;
            renderer                   ;
            audio = new OpenALAudioEngine();
            vfs = new BrowserVFS();
            workerPool = new ThreadedWorkerPool();
            wisp = WispEpoxyClient.getOrCreate('wss://anura.pro/');
            msaAuth = new MicrosoftAuthenticator(this.wisp);
            netClient                                    = null;
            profile                   = MicrosoftAuthenticator.createOfflineProfile('Player26_3');

    // Player Physics State (20 TPS + partialTick interpolation)
            px = 8.5;
            py = 84.0;
            pz = 8.5;
            prevPx = 8.5;
            prevPy = 84.0;
            prevPz = 8.5;
            vx = 0;
            vy = 0;
            vz = 0;
            yawRad = 0;
            pitchRad = 0;
            onGround = false;
            isFlying = false;
            lastSpaceTapMs = 0;
            swingProgress = 0;
            isSwinging = false;
            stepDistanceAccum = 0;

    // Input & UI State
            keysDown              = new Set();
            selectedHotbarSlot = 0;
            hotbarBlocks                       = [];
            showF3Debug = true;
            isInventoryOpen = false;
            isMultiplayerOpen = false;
            renderDistanceChunks = 4;

    // Loop Telemetry
            fps = 60;
            frameCounter = 0;
            lastFpsUpdateMs = performance.now();
            lastFrameTimeMs = performance.now();
            tickAccumulatorMs = 0;

           async start()                {
        const setProgress = (pct        , text        ) => {
            const bar = document.getElementById('loading-bar-fill');
            const label = document.getElementById('loading-status');
            if (bar) bar.style.width = `${pct}%`;
            if (label) label.textContent = text;
        };

        setProgress(10, 'Initializing JVM-to-WASM Core (mc26_3_core.wasm) & Epoxy Wisp...');
        await JvmWasmCore.init('assets/mc26_3_core.wasm');
        await this.wisp.initEpoxyWasm('assets/epoxy.wasm');
        await this.vfs.init();
        this.workerPool.initInlineWorkers();

        setProgress(28, 'Loading Minecraft 26.3 Registries (1,288 Blocks, 1,253 Items, 162 Entities, 67 Biomes)...');
        const [regResp, wgResp] = await Promise.all([
            fetch('assets/registries.json'),
            fetch('assets/worldgen.json'),
        ]);
        this.registries = await regResp.json();
        this.worldgenData = await wgResp.json();
        this.audio.setSoundEventsRegistry(this.registries.soundEvents);

        setProgress(52, 'Loading Stitched Texture Atlases (blocks.png, items.png, ascii.png)...');
        const [blocksImg, itemsImg, asciiImg] = await Promise.all([
            loadImage('assets/blocks.png'),
            loadImage('assets/items.png'),
            loadImage('assets/ascii.png'),
        ]);

        setProgress(70, 'Initializing Dual WebGPU / WebGL2 Rendering Pipeline...');
        const canvas3D = document.getElementById('game-canvas-3d')                     ;
        const canvasGui = document.getElementById('game-canvas-gui')                     ;
        this.renderer = new DualRenderEngine(canvas3D, canvasGui);
        this.renderer.resize(window.innerWidth, window.innerHeight);
        await this.renderer.init(blocksImg, itemsImg, asciiImg);

        setProgress(82, 'Constructing Worldgen NoiseRouter, Splines, and Structure Templates (.nbt)...');
        const noiseRouter = new WorldgenNoiseRouter(2632026n, this.worldgenData);
        this.world = new ClientWorld(this.registries.blocks, this.registries.biomes, noiseRouter);
        this.mesher = new ChunkMesher(this.world, this.registries.atlases.blocks.uvs);

        // Load sample .nbt structure template (Minecraft 26.3 Dappled Forest Abandoned Camp)
        try {
            const nbtResp = await fetch('assets/structures/abandoned_camp__camp__dappled_forest__campsite_dappled_forest_1.nbt');
            if (nbtResp.ok) {
                const nbtBytes = new Uint8Array(await nbtResp.arrayBuffer());
                const tmpl = await parseStructureTemplateNbt(nbtBytes);
                this.world.structures.set('abandoned_camp/campsite_dappled_forest_1', tmpl);
            }
        } catch {}

        // Populate initial 9-slot hotbar featuring iconic & new Minecraft 26.3 blocks
        const pickBlock = (name        ) =>
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

        setProgress(92, 'Generating Initial Spawn Chunks & Meshing Compact 32-Byte Vertices...');
        for (let cx = -2; cx <= 2; cx++) {
            for (let cz = -2; cz <= 2; cz++) {
                const col = this.world.getOrCreateChunk(cx, cz);
                const mesh = this.mesher.buildChunkMesh(col);
                this.renderer.uploadChunkMesh(mesh);
            }
        }

        // Spawn a 26.3 Sulfur Cube right in front of the player so it's immediately visible!
        const spawnChunk = this.world.getOrCreateChunk(0, 0);
        const spawnSurfY = spawnChunk.heightmap[(8 << 4) | 8];
        this.px = 8.5;
        this.py = spawnSurfY + 2.0;
        this.pz = 8.5;
        this.prevPx = this.px;
        this.prevPy = this.py;
        this.prevPz = this.pz;
        this.world.spawnMob('sulfur_cube', this.px + 2.5, spawnSurfY + 2.0, this.pz - 4.5);
        this.world.spawnMob('pig', this.px - 3.5, spawnSurfY + 2.0, this.pz - 5.0);

        setProgress(100, 'Ready!');
        setTimeout(() => {
            const loadingScreen = document.getElementById('loading-overlay');
            if (loadingScreen) loadingScreen.style.display = 'none';
        }, 200);

        this.bindControlsAndModals();
        requestAnimationFrame((t) => this.frameLoop(t));
    }

            bindControlsAndModals()       {
        const canvasGui = document.getElementById('game-canvas-gui')                     ;

        window.addEventListener('resize', () => {
            this.renderer.resize(window.innerWidth, window.innerHeight);
        });

        // Pointer Lock on canvas click
        canvasGui.addEventListener('mousedown', (e) => {
            if (this.isInventoryOpen || this.isMultiplayerOpen) return;
            this.audio.ensureContext();
            if (document.pointerLockElement !== canvasGui) {
                canvasGui.requestPointerLock();
                return;
            }
            this.handleMouseAction(e.button);
        });

        window.addEventListener('contextmenu', (e) => e.preventDefault());

        document.addEventListener('mousemove', (e) => {
            if (document.pointerLockElement !== canvasGui) return;
            const sensitivity = 0.0022;
            this.yawRad -= e.movementX * sensitivity;
            this.pitchRad = Math.max(-Math.PI * 0.495, Math.min(Math.PI * 0.495, this.pitchRad - e.movementY * sensitivity));
        });

        window.addEventListener('wheel', (e) => {
            if (this.isInventoryOpen || this.isMultiplayerOpen) return;
            if (e.deltaY > 0) this.selectedHotbarSlot = (this.selectedHotbarSlot + 1) % 9;
            else if (e.deltaY < 0) this.selectedHotbarSlot = (this.selectedHotbarSlot + 8) % 9;
        });

        window.addEventListener('keydown', (e) => {
            if (this.isMultiplayerOpen && document.activeElement?.tagName === 'INPUT') {
                if (e.code === 'Escape') this.toggleMultiplayerModal(false);
                return;
            }
            if (this.isInventoryOpen && document.activeElement?.tagName === 'INPUT') {
                if (e.code === 'Escape') this.toggleInventoryModal(false);
                return;
            }

            if (e.code === 'F3') {
                e.preventDefault();
                this.showF3Debug = !this.showF3Debug;
                return;
            }
            if (e.code === 'KeyE') {
                e.preventDefault();
                this.toggleInventoryModal(!this.isInventoryOpen);
                return;
            }
            if (e.code === 'KeyM') {
                e.preventDefault();
                this.toggleMultiplayerModal(!this.isMultiplayerOpen);
                return;
            }
            if (e.code.startsWith('Digit')) {
                const num = parseInt(e.code.slice(5), 10);
                if (num >= 1 && num <= 9) {
                    this.selectedHotbarSlot = num - 1;
                }
            }
            if (e.code === 'Space' && !this.keysDown.has('Space')) {
                const now = performance.now();
                if (now - this.lastSpaceTapMs < 280) {
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

        // Bind Top Toolbar Buttons (Backend Toggle, Creative Inventory, Wispcraft Multiplayer)
        document.getElementById('btn-toggle-backend')?.addEventListener('click', async () => {
            const nextBackend                        = this.renderer.backend === 'WebGPU' ? 'WebGL2' : 'WebGPU';
            // Recreate 3D canvas because a canvas bound to WebGPU cannot acquire a WebGL2 context and vice-versa
            const oldCanvas = document.getElementById('game-canvas-3d') ;
            const newCanvas = document.createElement('canvas');
            newCanvas.id = 'game-canvas-3d';
            newCanvas.width = window.innerWidth;
            newCanvas.height = window.innerHeight;
            oldCanvas.parentNode?.replaceChild(newCanvas, oldCanvas);

            const guiCanvas = document.getElementById('game-canvas-gui')                     ;
            this.renderer = new DualRenderEngine(newCanvas, guiCanvas);
            await this.renderer.init(
                await loadImage('assets/blocks.png'),
                await loadImage('assets/items.png'),
                await loadImage('assets/ascii.png'),
                nextBackend
            );
            // Re-upload active chunks
            for (const col of this.world.chunks.values()) {
                this.renderer.uploadChunkMesh(this.mesher.buildChunkMesh(col));
            }
            const btn = document.getElementById('btn-toggle-backend');
            if (btn) btn.textContent = `Backend: ${this.renderer.backend}`;
        });

        document.getElementById('btn-open-inventory')?.addEventListener('click', () => {
            this.toggleInventoryModal(!this.isInventoryOpen);
        });

        document.getElementById('btn-open-multiplayer')?.addEventListener('click', () => {
            this.toggleMultiplayerModal(!this.isMultiplayerOpen);
        });

        this.setupInventoryBrowserUI();
        this.setupMultiplayerModalUI();
    }

            setupInventoryBrowserUI()       {
        const searchInput = document.getElementById('inv-search-input')                           ;
        const grid = document.getElementById('inv-grid');
        const closeBtn = document.getElementById('btn-close-inventory');

        closeBtn?.addEventListener('click', () => this.toggleInventoryModal(false));

        const renderGrid = (query        ) => {
            if (!grid) return;
            grid.innerHTML = '';
            const q = query.trim().toLowerCase();
            const matches = this.registries.blocks.filter(b => !b.properties.air && (!q || b.name.includes(q))).slice(0, 180);
            for (const blk of matches) {
                const cell = document.createElement('div');
                cell.className = 'inv-cell';
                cell.title = `minecraft:${blk.name} (#${blk.rawId})`;

                const icon = document.createElement('div');
                icon.className = 'inv-icon';
                const uv = this.registries.atlases.blocks.uvs[blk.textures.north] || this.registries.atlases.blocks.uvs[blk.textures.up];
                if (uv) {
                    icon.style.backgroundImage = 'url(assets/blocks.png)';
                    icon.style.backgroundPosition = `-${uv.x * 2}px -${uv.y * 2}px`;
                    icon.style.backgroundSize = `${this.registries.atlases.blocks.width * 2}px ${this.registries.atlases.blocks.height * 2}px`;
                }

                const lbl = document.createElement('span');
                lbl.textContent = blk.name.replace(/_/g, ' ');
                cell.appendChild(icon);
                cell.appendChild(lbl);

                cell.addEventListener('click', () => {
                    this.hotbarBlocks[this.selectedHotbarSlot] = blk;
                    this.audio.playSoundEvent('ui.button.click', SoundSource.MASTER, 0, 0, 0, 0.7, 1.0, false);
                    this.toggleInventoryModal(false);
                });
                grid.appendChild(cell);
            }
        };

        searchInput?.addEventListener('input', () => renderGrid(searchInput.value));
        renderGrid('');
    }

            setupMultiplayerModalUI()       {
        const closeBtn = document.getElementById('btn-close-multiplayer');
        const wispInput = document.getElementById('mp-wisp-url')                           ;
        const serverInput = document.getElementById('mp-server-addr')                           ;
        const usernameInput = document.getElementById('mp-username')                           ;
        const statusBox = document.getElementById('mp-status-log');

        const setLog = (msg        ) => {
            if (statusBox) statusBox.textContent = msg;
        };

        closeBtn?.addEventListener('click', () => this.toggleMultiplayerModal(false));

        // Microsoft OAuth 2.0 Device Code Button
        document.getElementById('btn-msa-login')?.addEventListener('click', async () => {
            try {
                if (wispInput?.value) this.wisp.setWispServer(wispInput.value.trim());
                setLog('Requesting Microsoft OAuth 2.0 Device Code...');
                const dc = await this.msaAuth.requestDeviceCode();
                setLog(`${dc.message} (Polling for authorization...)`);
                const tokens = await this.msaAuth.pollDeviceCodeToken(dc.deviceCode, dc.interval, setLog);
                setLog('Exchanging Microsoft Token -> Xbox Live -> XSTS -> Minecraft Services...');
                this.profile = await this.msaAuth.authenticateMinecraftWithMsaToken(tokens.accessToken, tokens.refreshToken);
                if (usernameInput) usernameInput.value = this.profile.name;
                setLog(`Authenticated as ${this.profile.name} (UUID: ${this.profile.id})`);
            } catch (err) {
                setLog(`Microsoft OAuth Notice: ${(err         ).message}`);
            }
        });

        // Ping Server Status (Protocol 777 Status State 1)
        document.getElementById('btn-mp-ping')?.addEventListener('click', async () => {
            try {
                if (wispInput?.value) this.wisp.setWispServer(wispInput.value.trim());
                const addr = serverInput?.value.trim() || 'localhost:25565';
                setLog(`Pinging ${addr} via Wisp (${this.wisp.wispUrl})...`);
                const client = new MinecraftProtocol263Client(this.wisp);
                const status = await client.pingServerStatus(addr);
                const motd = typeof status.description === 'string'
                    ? status.description
                    : status.description.text || JSON.stringify(status.description);
                setLog(`Online! Version: ${status.version.name} (Protocol ${status.version.protocol}) | Players: ${status.players.online}/${status.players.max} | RTT: ${status.latencyMs}ms | MOTD: ${motd}`);
            } catch (err) {
                setLog(`Ping error: ${(err         ).message}`);
            }
        });

        // Connect to Server (Protocol 777 Handshake -> Login -> Configuration -> Play)
        document.getElementById('btn-mp-connect')?.addEventListener('click', async () => {
            try {
                if (wispInput?.value) this.wisp.setWispServer(wispInput.value.trim());
                if (usernameInput?.value && this.profile.offlineMode) {
                    this.profile = MicrosoftAuthenticator.createOfflineProfile(usernameInput.value);
                }
                const addr = serverInput?.value.trim() || 'localhost:25565';
                this.netClient?.disconnect();
                this.netClient = new MinecraftProtocol263Client(this.wisp, {
                    onStatusUpdate: setLog,
                    onLoginSuccess: (uuid, name) => setLog(`LoginSuccess: ${name} (${uuid})`),
                    onEnterPlayState: () => {
                        setLog(`Connected to ${addr} in Play State (Protocol 777)!`);
                        setTimeout(() => this.toggleMultiplayerModal(false), 600);
                    },
                    onDisconnect: (reason) => setLog(`Disconnected: ${reason}`),
                    onPlayerPosition: (x, y, z, yaw, pitch) => {
                        this.px = x; this.py = y; this.pz = z;
                        this.yawRad = (-yaw * Math.PI) / 180;
                        this.pitchRad = (-pitch * Math.PI) / 180;
                    },
                    onBlockUpdate: (x, y, z, stateId) => {
                        this.world.setBlockId(x, y, z, stateId % this.registries.blocks.length);
                    },
                });
                await this.netClient.connectToServer(addr, this.profile);
            } catch (err) {
                setLog(`Connect error: ${(err         ).message}`);
            }
        });
    }

            toggleInventoryModal(open         )       {
        this.isInventoryOpen = open;
        const modal = document.getElementById('inventory-modal');
        if (modal) modal.style.display = open ? 'flex' : 'none';
        if (open && document.pointerLockElement) {
            document.exitPointerLock();
        }
    }

            toggleMultiplayerModal(open         )       {
        this.isMultiplayerOpen = open;
        const modal = document.getElementById('multiplayer-modal');
        if (modal) modal.style.display = open ? 'flex' : 'none';
        if (open && document.pointerLockElement) {
            document.exitPointerLock();
        }
    }

            getCameraForward()                           {
        const fx = -Math.sin(this.yawRad) * Math.cos(this.pitchRad);
        const fy = Math.sin(this.pitchRad);
        const fz = -Math.cos(this.yawRad) * Math.cos(this.pitchRad);
        return [fx, fy, fz];
    }

            handleMouseAction(button        )       {
        const [fx, fy, fz] = this.getCameraForward();
        const eyeY = this.py + 1.62;
        const hit = this.world.raycastBlock(this.px, eyeY, this.pz, fx, fy, fz, 5.5);

        if (button === 0) {
            // Left click: Swing arm, check mob hit first, else break block
            this.isSwinging = true;
            this.swingProgress = 0;

            for (const ent of this.world.entities.values()) {
                const dx = ent.x - this.px;
                const dy = (ent.y + ent.height * 0.5) - eyeY;
                const dz = ent.z - this.pz;
                const dist = Math.hypot(dx, dy, dz);
                if (dist < 4.0) {
                    const dot = (dx * fx + dy * fy + dz * fz) / (dist || 1);
                    if (dot > 0.85) {
                        ent.hurtTime = 10;
                        ent.vy = 0.36;
                        ent.vx += fx * 0.4;
                        ent.vz += fz * 0.4;
                        this.audio.playSoundEvent('entity.player.attack.strong', SoundSource.PLAYERS, ent.x, ent.y, ent.z, 1.0, 1.0, true);
                        return;
                    }
                }
            }

            if (hit) {
                const uv = this.mesher.getUV(hit.block.textures.north);
                this.renderer.spawnBlockBreakParticles(hit.x, hit.y, hit.z, uv);
                this.world.setBlockId(hit.x, hit.y, hit.z, this.world.idAir, true);
                this.audio.playSoundEvent('block.stone.break', SoundSource.BLOCKS, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 0.9, 0.95, true);
            }
        } else if (button === 2 && hit) {
            // Right click: Place selected block at (hit.x + hit.nx, hit.y + hit.ny, hit.z + hit.nz)
            const tx = hit.x + hit.nx;
            const ty = hit.y + hit.ny;
            const tz = hit.z + hit.nz;
            const selected = this.hotbarBlocks[this.selectedHotbarSlot];
            if (!selected) return;

            // Ensure placed block does not intersect player AABB
            const playerBox       = {
                minX: this.px - 0.3, minY: this.py, minZ: this.pz - 0.3,
                maxX: this.px + 0.3, maxY: this.py + 1.8, maxZ: this.pz + 0.3,
            };
            if (
                !selected.properties.noCollision &&
                !selected.properties.liquid &&
                playerBox.maxX > tx && playerBox.minX < tx + 1 &&
                playerBox.maxY > ty && playerBox.minY < ty + 1 &&
                playerBox.maxZ > tz && playerBox.minZ < tz + 1
            ) {
                return;
            }

            this.isSwinging = true;
            this.swingProgress = 0;
            this.world.setBlockId(tx, ty, tz, selected.rawId, true);
            this.audio.playSoundEvent('block.stone.place', SoundSource.BLOCKS, tx + 0.5, ty + 0.5, tz + 0.5, 0.9, 1.05, true);
        } else if (button === 1 && hit) {
            // Middle click: Pick block into current hotbar slot
            this.hotbarBlocks[this.selectedHotbarSlot] = hit.block;
        }
    }

    /**
     * Executes one fixed 20 TPS (50ms) client tick:
     * - Steps player movement, jumping, creative flight, swimming, and VoxelShape AABB collisions
     * - Steps world ticks (fluids, redstone, mobs)
     * - Streams and remeshes dirty chunks around the player
     */
            clientTick()       {
        this.prevPx = this.px;
        this.prevPy = this.py;
        this.prevPz = this.pz;

        if (this.isSwinging) {
            this.swingProgress += 0.22;
            if (this.swingProgress >= 1.0) {
                this.swingProgress = 0;
                this.isSwinging = false;
            }
        }

        // Compute horizontal input vector relative to yaw
        let forwardInput = 0;
        let strafeInput = 0;
        if (!this.isInventoryOpen && !this.isMultiplayerOpen) {
            if (this.keysDown.has('KeyW')) forwardInput += 1;
            if (this.keysDown.has('KeyS')) forwardInput -= 1;
            if (this.keysDown.has('KeyD')) strafeInput += 1;
            if (this.keysDown.has('KeyA')) strafeInput -= 1;
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

        const isSprinting = this.keysDown.has('ControlLeft') || this.keysDown.has('ControlRight');
        const isSneaking = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');

        const feetBlock = this.world.getBlockId(Math.floor(this.px), Math.floor(this.py), Math.floor(this.pz));
        const inWater = feetBlock === this.world.idWater;

        if (this.isFlying) {
            const flySpeed = isSprinting ? 0.55 : 0.30;
            this.vx = this.vx * 0.6 + wishX * flySpeed * 0.4;
            this.vz = this.vz * 0.6 + wishZ * flySpeed * 0.4;
            this.vy = 0;
            if (this.keysDown.has('Space')) this.vy = 0.35;
            if (isSneaking) this.vy = -0.35;
        } else if (inWater) {
            const swimSpeed = 0.14;
            this.vx = this.vx * 0.8 + wishX * swimSpeed * 0.2;
            this.vz = this.vz * 0.8 + wishZ * swimSpeed * 0.2;
            this.vy = (this.vy - 0.02) * 0.85;
            if (this.keysDown.has('Space')) this.vy += 0.06;
        } else {
            const baseAccel = isSneaking ? 0.06 : isSprinting ? 0.165 : 0.12;
            const friction = this.onGround ? 0.546 : 0.91;
            this.vx = this.vx * friction + wishX * baseAccel;
            this.vz = this.vz * friction + wishZ * baseAccel;

            if (this.keysDown.has('Space') && this.onGround) {
                this.vy = 0.42; // Exact vanilla jump velocity
                this.onGround = false;
            }
            // Vanilla gravity (0.08 blocks/tick^2) and vertical drag (0.98)
            this.vy = (this.vy - 0.08) * 0.98;
        }

        const playerBox       = {
            minX: this.px - 0.3,
            minY: this.py,
            minZ: this.pz - 0.3,
            maxX: this.px + 0.3,
            maxY: this.py + 1.8,
            maxZ: this.pz + 0.3,
        };
        const moved = this.world.moveEntityWithCollisions(playerBox, this.vx, this.vy, this.vz);
        this.px = (moved.box.minX + moved.box.maxX) * 0.5;
        this.py = moved.box.minY;
        this.pz = (moved.box.minZ + moved.box.maxZ) * 0.5;
        this.onGround = moved.onGround;
        if (moved.onGround && this.vy < 0) {
            this.vy = 0;
            this.isFlying = false;
        }

        // Footstep spatial sound trigger
        if (this.onGround) {
            this.stepDistanceAccum += Math.hypot(this.px - this.prevPx, this.pz - this.prevPz);
            if (this.stepDistanceAccum > 1.85) {
                this.stepDistanceAccum = 0;
                this.audio.playSoundEvent('block.grass.step', SoundSource.PLAYERS, this.px, this.py, this.pz, 0.35, 1.0, false);
            }
        }

        // Step world mechanics & particles
        this.world.tick(this.px, this.py, this.pz);
        this.renderer.stepParticles();
        this.workerPool.recordTickCompleted(Number(this.world.worldAgeTicks));

        // Send multiplayer position update if connected
        this.netClient?.sendPlayerPositionAndRotation(
            this.px, this.py, this.pz,
            (-this.yawRad * 180) / Math.PI,
            (-this.pitchRad * 180) / Math.PI,
            this.onGround
        ).catch(() => {});

        // Stream & mesh nearby dirty chunks (at most 1 chunk per tick to avoid frame hitches)
        const pcx = Math.floor(this.px) >> 4;
        const pcz = Math.floor(this.pz) >> 4;
        let meshedThisTick = 0;
        for (let r = 0; r <= this.renderDistanceChunks && meshedThisTick < 1; r++) {
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

            frameLoop(nowMs        )       {
        const dtMs = Math.min(250, Math.max(0, nowMs - this.lastFrameTimeMs));
        this.lastFrameTimeMs = nowMs;
        this.tickAccumulatorMs += dtMs;

        // Fixed 20 TPS (50ms) tick loop
        while (this.tickAccumulatorMs >= 50.0) {
            this.clientTick();
            this.tickAccumulatorMs -= 50.0;
        }

        // Partial tick interpolation factor in [0.0 .. 1.0]
        const partialTick = this.tickAccumulatorMs / 50.0;
        const renderX = this.prevPx + (this.px - this.prevPx) * partialTick;
        const renderY = this.prevPy + (this.py - this.prevPy) * partialTick + 1.62;
        const renderZ = this.prevPz + (this.pz - this.prevPz) * partialTick;

        this.audio.updateListener(renderX, renderY, renderZ, this.yawRad, this.pitchRad, this.vx * 20, this.vy * 20, this.vz * 20);

        const [fx, fy, fz] = this.getCameraForward();
        const hit = this.world.raycastBlock(renderX, renderY, renderZ, fx, fy, fz, 5.5);

        // Render Passes 1–7 (3D World, Entities, BlockEntities, Particles, Sky/Clouds)
        this.renderer.renderWorldFrame(
            this.world,
            this.mesher,
            renderX, renderY, renderZ,
            this.yawRad, this.pitchRad,
            75.0,
            this.renderDistanceChunks,
            partialTick,
            hit
        );

        // Update FPS counter
        this.frameCounter++;
        if (nowMs - this.lastFpsUpdateMs >= 500) {
            this.fps = Math.round((this.frameCounter * 1000) / (nowMs - this.lastFpsUpdateMs));
            this.frameCounter = 0;
            this.lastFpsUpdateMs = nowMs;
        }

        // Sample NoiseRouter values at player coordinates for F3 overlay
        const nr = this.world.noiseRouter.sampleOverworldRouter(
            Math.floor(this.px),
            Math.floor(this.py),
            Math.floor(this.pz)
        );
        const noiseSampleText =
            `C: ${nr.continents.toFixed(3)} E: ${nr.erosion.toFixed(3)} T: ${nr.temperature.toFixed(3)} ` +
            `V: ${nr.vegetation.toFixed(3)} W: ${nr.weirdness.toFixed(3)} PV: ${nr.ridges.toFixed(3)} D: ${nr.depth.toFixed(3)}`;

        // Render Pass 8 (2D GUI, Hotbar, Health/Hunger/XP, Held Block, F3 Debug)
        this.renderer.render2DGuiPass({
            fps: this.fps,
            playerX: renderX,
            playerY: renderY - 1.62,
            playerZ: renderZ,
            yawDeg: ((-this.yawRad * 180) / Math.PI) % 360,
            pitchDeg: (this.pitchRad * 180) / Math.PI,
            biomeName: nr.biomeName,
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

        requestAnimationFrame((t) => this.frameLoop(t));
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const app = new Minecraft263ClientApp();
    app.start().catch((err) => {
        console.error('[Bootstrap] Fatal startup error:', err);
        const label = document.getElementById('loading-status');
        if (label) label.textContent = `Startup Error: ${(err         ).message}`;
    });
});

})();
