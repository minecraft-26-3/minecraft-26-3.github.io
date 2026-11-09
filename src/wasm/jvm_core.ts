/**
 * JVM-to-WASM Native Bridge & Pinned Memory Manager (`mc26_3_core.wasm`)
 *
 * Bridges Java 25 (Classfile version 69.0) 64-bit `long` math, `BlockPos` bit-packing,
 * `Xoroshiro128++` PRNG, Perlin/Simplex 3D gradients, and zero-GC pinned native memory
 * vertex buffers (`ByteBuffer.allocateDirect()`) to WebAssembly linear memory.
 */

export interface Mc263WasmExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    packBlockPos(x: number, y: number, z: number): bigint;
    unpackBlockPosX(pos: bigint): number;
    unpackBlockPosY(pos: bigint): number;
    unpackBlockPosZ(pos: bigint): number;
    xoroInit(stateOffset: number, seedLo: bigint, seedHi: bigint): void;
    xoroNextLong(stateOffset: number): bigint;
    xoroNextInt(stateOffset: number, bound: number): number;
    xoroNextFloat(stateOffset: number): number;
    xoroNextDouble(stateOffset: number): number;
    perlinFade(t: number): number;
    perlinLerp(t: number, a: number, b: number): number;
    perlinGradDot(hash: number, x: number, y: number, z: number): number;
    packVertex(
        dstByteOffset: number,
        x: number, y: number, z: number,
        u: number, v: number,
        normalPacked: number,
        lightPacked: number,
        rgbaColor: number
    ): number;
    adler32(ptr: number, len: number): number;
    writeVarInt(ptr: number, val: number): number;
    readVarInt(ptr: number): bigint;
}

export class JvmWasmCore {
    public static instance: JvmWasmCore | null = null;
    public readonly exports: Mc263WasmExports;
    public memoryU8!: Uint8Array;
    public memoryI32!: Int32Array;
    public memoryU32!: Uint32Array;
    public memoryF32!: Float32Array;
    public memoryI64!: BigInt64Array;

    // Memory map inside mc26_3_core.wasm (64 pages = 4MB initial, expandable to 32MB):
    // 0x000000 - 0x000FFF: 256 Xoroshiro128++ PRNG state slots (16 bytes each)
    // 0x001000 - 0x00FFFF: Network packet VarInt & Zlib Adler32 scratch buffer (60 KB)
    // 0x010000 - 0x3FFFFF: Direct ByteBuffer Arena for Chunk Meshing & GPU upload (~4 MB)
    private nextPrngSlot = 0;
    private directArenaPtr = 0x010000;

    private constructor(exports: Mc263WasmExports) {
        this.exports = exports;
        this.refreshViews();
    }

    public static async init(wasmUrl = 'assets/mc26_3_core.wasm'): Promise<JvmWasmCore> {
        if (JvmWasmCore.instance) return JvmWasmCore.instance;
        const resp = await fetch(wasmUrl);
        const bytes = await resp.arrayBuffer();
        const { instance } = await WebAssembly.instantiate(bytes, {});
        JvmWasmCore.instance = new JvmWasmCore(instance.exports as Mc263WasmExports);
        return JvmWasmCore.instance;
    }

    public refreshViews(): void {
        const buf = this.exports.memory.buffer;
        if (!this.memoryU8 || this.memoryU8.buffer !== buf) {
            this.memoryU8 = new Uint8Array(buf);
            this.memoryI32 = new Int32Array(buf);
            this.memoryU32 = new Uint32Array(buf);
            this.memoryF32 = new Float32Array(buf);
            this.memoryI64 = new BigInt64Array(buf);
        }
    }

    public allocPrngStateOffset(): number {
        const slot = (this.nextPrngSlot++ & 0xff) * 16;
        return slot;
    }

    /**
     * Emulates Java `ByteBuffer.allocateDirect(byteLength)` backed by pinned WASM linear memory.
     */
    public allocateDirect(byteLength: number): { byteOffset: number; u8: Uint8Array; f32: Float32Array; u32: Uint32Array } {
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

    public resetDirectArena(): void {
        this.directArenaPtr = 0x010000;
    }
}
