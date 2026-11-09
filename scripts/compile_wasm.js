const fs = require('fs');
const path = require('path');

// Pure-JS WebAssembly Binary Module Compiler for Minecraft 26.3 Native Core
// Produces `public/assets/mc26_3_core.wasm` implementing:
// 1. 64-bit `i64` bitwise math & BlockPos packing/unpacking:
//    packBlockPos(x: i32, y: i32, z: i32) -> i64
//    unpackBlockPosX(pos: i64) -> i32
//    unpackBlockPosY(pos: i64) -> i32
//    unpackBlockPosZ(pos: i64) -> i32
// 2. Xoroshiro128++ 64-bit PRNG (state stored in linear memory or passed):
//    xoroInit(stateOffset: i32, seedLo: i64, seedHi: i64)
//    xoroNextLong(stateOffset: i32) -> i64
//    xoroNextInt(stateOffset: i32, bound: i32) -> i32
//    xoroNextFloat(stateOffset: i32) -> f32
//    xoroNextDouble(stateOffset: i32) -> f64
// 3. Deterministic ImprovedNoise / Perlin 3D fade, grad, and trilinear evaluation in WASM f64:
//    perlinFade(t: f64) -> f64
//    perlinLerp(t: f64, a: f64, b: f64) -> f64
//    perlinGradDot(hash: i32, x: f64, y: f64, z: f64) -> f64
// 4. Compact 32-bit Chunk Vertex Packing into pinned WebAssembly.Memory:
//    packVertex(dstByteOffset: i32, x: f32, y: f32, z: f32, u: f32, v: f32, normalPacked: i32, lightPacked: i32, rgbaColor: i32) -> i32
// 5. Fast Adler32 & VarInt encoding/decoding in linear memory:
//    adler32(ptr: i32, len: i32) -> i32
//    writeVarInt(ptr: i32, val: i32) -> i32
//    readVarInt(ptr: i32) -> i64 (low 32 = value, high 32 = bytesRead)

function uleb128(val) {
    const out = [];
    val >>>= 0;
    do {
        let byte = val & 0x7f;
        val >>>= 7;
        if (val !== 0) byte |= 0x80;
        out.push(byte);
    } while (val !== 0);
    return out;
}

function sleb128(val) {
    const out = [];
    let more = true;
    while (more) {
        let byte = val & 0x7f;
        val >>= 7;
        if ((val === 0 && (byte & 0x40) === 0) || (val === -1 && (byte & 0x40) !== 0)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out.push(byte);
    }
    return out;
}

function sleb128_64(bigVal) {
    bigVal = BigInt(bigVal);
    const out = [];
    let more = true;
    while (more) {
        let byte = Number(bigVal & 0x7fn);
        bigVal >>= 7n;
        if ((bigVal === 0n && (byte & 0x40) === 0) || (bigVal === -1n && (byte & 0x40) !== 0)) {
            more = false;
        } else {
            byte |= 0x80;
        }
        out.push(byte);
    }
    return out;
}

function f64Bytes(val) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(val, 0);
    return [...b];
}

function f32Bytes(val) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(val, 0);
    return [...b];
}

function encodeString(str) {
    const buf = Buffer.from(str, 'utf8');
    return [...uleb128(buf.length), ...buf];
}

function section(id, payload) {
    return [id, ...uleb128(payload.length), ...payload];
}

function vec(items) {
    const out = [...uleb128(items.length)];
    for (const item of items) out.push(...item);
    return out;
}

const I32 = 0x7f;
const I64 = 0x7e;
const F32 = 0x7d;
const F64 = 0x7c;
const FUNC = 0x60;

// Function Type Signatures:
// 0: (i32, i32, i32) -> (i64)              [packBlockPos]
// 1: (i64) -> (i32)                        [unpackBlockPosX, Y, Z]
// 2: (i32, i64, i64) -> ()                 [xoroInit]
// 3: (i32) -> (i64)                        [xoroNextLong, readVarInt]
// 4: (i32, i32) -> (i32)                   [xoroNextInt, adler32, writeVarInt]
// 5: (i32) -> (f32)                        [xoroNextFloat]
// 6: (i32) -> (f64)                        [xoroNextDouble]
// 7: (f64) -> (f64)                        [perlinFade]
// 8: (f64, f64, f64) -> (f64)              [perlinLerp]
// 9: (i32, f64, f64, f64) -> (f64)         [perlinGradDot]
// 10: (i32, f32, f32, f32, f32, f32, i32, i32, i32) -> (i32) [packVertex]
const types = [
    [FUNC, ...vec([[I32], [I32], [I32]]), ...vec([[I64]])],
    [FUNC, ...vec([[I64]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32], [I64], [I64]]), ...vec([])],
    [FUNC, ...vec([[I32]]), ...vec([[I64]])],
    [FUNC, ...vec([[I32], [I32]]), ...vec([[I32]])],
    [FUNC, ...vec([[I32]]), ...vec([[F32]])],
    [FUNC, ...vec([[I32]]), ...vec([[F64]])],
    [FUNC, ...vec([[F64]]), ...vec([[F64]])],
    [FUNC, ...vec([[F64], [F64], [F64]]), ...vec([[F64]])],
    [FUNC, ...vec([[I32], [F64], [F64], [F64]]), ...vec([[F64]])],
    [FUNC, ...vec([[I32], [F32], [F32], [F32], [F32], [F32], [I32], [I32], [I32]]), ...vec([[I32]])],
];

// Function list:
// 0: packBlockPos (type 0)
// 1: unpackBlockPosX (type 1)
// 2: unpackBlockPosY (type 1)
// 3: unpackBlockPosZ (type 1)
// 4: xoroInit (type 2)
// 5: xoroNextLong (type 3)
// 6: xoroNextInt (type 4)
// 7: xoroNextFloat (type 5)
// 8: xoroNextDouble (type 6)
// 9: perlinFade (type 7)
// 10: perlinLerp (type 8)
// 11: perlinGradDot (type 9)
// 12: packVertex (type 10)
// 13: adler32 (type 4)
// 14: writeVarInt (type 4)
// 15: readVarInt (type 3)
const funcTypes = [0, 1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 4, 4, 3];

function makeFuncBody(locals, codeBytes) {
    const body = [...vec(locals), ...codeBytes, 0x0b];
    return [...uleb128(body.length), ...body];
}

// 0: packBlockPos(x: i32, y: i32, z: i32) -> i64
// (((x as i64) & 0x3FFFFFF) << 38) | (((z as i64) & 0x3FFFFFF) << 12) | ((y as i64) & 0xFFF)
const bodyPackBlockPos = makeFuncBody([], [
    0x20, 0x00, 0xad, // local.get 0, i64.extend_i32_u
    0x42, ...sleb128_64(0x3ffffffn), 0x83, // i64.const 0x3ffffff, i64.and
    0x42, 38, 0x86, // i64.const 38, i64.shl
    0x20, 0x02, 0xad, // local.get 2 (z), i64.extend_i32_u
    0x42, ...sleb128_64(0x3ffffffn), 0x83, // i64.const 0x3ffffff, i64.and
    0x42, 12, 0x86, // i64.const 12, i64.shl
    0x84, // i64.or
    0x20, 0x01, 0xad, // local.get 1 (y), i64.extend_i32_u
    0x42, ...sleb128_64(0xfffn), 0x83, // i64.const 0xfff, i64.and
    0x84 // i64.or
]);

// 1: unpackBlockPosX(pos: i64) -> i32: i32.wrap_i64(pos >> 38)
const bodyUnpackX = makeFuncBody([], [
    0x20, 0x00, // local.get 0
    0x42, 38, 0x87, // i64.const 38, i64.shr_s
    0xa7 // i32.wrap_i64
]);

// 2: unpackBlockPosY(pos: i64) -> i32: i32.wrap_i64((pos << 52) >> 52)
const bodyUnpackY = makeFuncBody([], [
    0x20, 0x00, // local.get 0
    0x42, 52, 0x86, // i64.const 52, i64.shl
    0x42, 52, 0x87, // i64.const 52, i64.shr_s
    0xa7 // i32.wrap_i64
]);

// 3: unpackBlockPosZ(pos: i64) -> i32: i32.wrap_i64((pos << 26) >> 38)
const bodyUnpackZ = makeFuncBody([], [
    0x20, 0x00, // local.get 0
    0x42, 26, 0x86, // i64.const 26, i64.shl
    0x42, 38, 0x87, // i64.const 38, i64.shr_s
    0xa7 // i32.wrap_i64
]);

// 4: xoroInit(stateOffset: i32, seedLo: i64, seedHi: i64)
// Stores seedLo at [stateOffset], seedHi at [stateOffset + 8]; if both 0, stores Golden/Silver ratio constants
const bodyXoroInit = makeFuncBody([], [
    0x20, 0x00, 0x20, 0x01, 0x37, 0x03, 0x00, // i64.store offset=0
    0x20, 0x00, 0x20, 0x02, 0x37, 0x03, 0x08, // i64.store offset=8
    // Check if (seedLo | seedHi) == 0
    0x20, 0x01, 0x20, 0x02, 0x84, 0x50, // i64.or, i64.eqz
    0x04, 0x40, // if
    0x20, 0x00, 0x42, ...sleb128_64(-7046029254386353131n), 0x37, 0x03, 0x00,
    0x20, 0x00, 0x42, ...sleb128_64(7640891576956012809n), 0x37, 0x03, 0x08,
    0x0b
]);

// 5: xoroNextLong(stateOffset: i32) -> i64
// Locals: 1: s0 (i64), 2: s1 (i64), 3: res (i64)
// res = rotl(s0 + s1, 17) + s0
// s1 ^= s0
// s0 = rotl(s0, 49) ^ s1 ^ (s1 << 21)
// s1 = rotl(s1, 28)
const bodyXoroNextLong = makeFuncBody([[3, I64]], [
    0x20, 0x00, 0x29, 0x03, 0x00, 0x21, 0x01, // s0 = i64.load(stateOffset + 0)
    0x20, 0x00, 0x29, 0x03, 0x08, 0x21, 0x02, // s1 = i64.load(stateOffset + 8)
    // res = rotl(s0 + s1, 17) + s0
    0x20, 0x01, 0x20, 0x02, 0x7c, // s0 + s1
    0x42, 17, 0x89, // i64.rotl 17
    0x20, 0x01, 0x7c, // + s0
    0x21, 0x03, // local.set 3 (res)
    // s1 ^= s0
    0x20, 0x02, 0x20, 0x01, 0x85, 0x21, 0x02, // s1 = s1 ^ s0
    // mem[stateOffset + 0] = rotl(s0, 49) ^ s1 ^ (s1 << 21)
    0x20, 0x00,
    0x20, 0x01, 0x42, 49, 0x89, // rotl(s0, 49)
    0x20, 0x02, 0x85, // ^ s1
    0x20, 0x02, 0x42, 21, 0x86, // s1 << 21
    0x85, // ^
    0x37, 0x03, 0x00, // i64.store offset=0
    // mem[stateOffset + 8] = rotl(s1, 28)
    0x20, 0x00,
    0x20, 0x02, 0x42, 28, 0x89, // rotl(s1, 28)
    0x37, 0x03, 0x08, // i64.store offset=8
    // return res
    0x20, 0x03
]);

// 6: xoroNextInt(stateOffset: i32, bound: i32) -> i32
// Uses exact unsigned 64-bit multiplication ((nextLong() & 0xFFFFFFFF) * bound) >> 32
const bodyXoroNextInt = makeFuncBody([], [
    0x20, 0x00, 0x10, 0x05, // call xoroNextLong(stateOffset)
    0x42, ...sleb128_64(0xffffffffn), 0x83, // & 0xFFFFFFFF
    0x20, 0x01, 0xad, // i64.extend_i32_u(bound)
    0x7e, // i64.mul
    0x42, 32, 0x88, // i64.shr_u 32
    0xa7 // i32.wrap_i64
]);

// 7: xoroNextFloat(stateOffset: i32) -> f32
// (nextLong() >>> 40) * 5.9604645e-8f
const bodyXoroNextFloat = makeFuncBody([], [
    0x20, 0x00, 0x10, 0x05, // call xoroNextLong
    0x42, 40, 0x88, // >>> 40
    0xb4, // f32.convert_i64_s
    0x43, ...f32Bytes(5.9604645e-8),
    0x94 // f32.mul
]);

// 8: xoroNextDouble(stateOffset: i32) -> f64
// (nextLong() >>> 11) * 1.1102230246251565e-16
const bodyXoroNextDouble = makeFuncBody([], [
    0x20, 0x00, 0x10, 0x05, // call xoroNextLong
    0x42, 11, 0x88, // >>> 11
    0xb9, // f64.convert_i64_s
    0x44, ...f64Bytes(1.1102230246251565e-16),
    0xa2 // f64.mul
]);

// 9: perlinFade(t: f64) -> f64: t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
const bodyPerlinFade = makeFuncBody([], [
    0x20, 0x00, 0x20, 0x00, 0xa2, 0x20, 0x00, 0xa2, // t * t * t
    0x20, 0x00,
    0x20, 0x00, 0x44, ...f64Bytes(6.0), 0xa2,
    0x44, ...f64Bytes(15.0), 0xa1, // t * 6.0 - 15.0
    0xa2, // t * (...)
    0x44, ...f64Bytes(10.0), 0xa0, // + 10.0
    0xa2 // *
]);

// 10: perlinLerp(t: f64, a: f64, b: f64) -> f64: a + t * (b - a)
const bodyPerlinLerp = makeFuncBody([], [
    0x20, 0x01, // a
    0x20, 0x00, // t
    0x20, 0x02, 0x20, 0x01, 0xa1, // b - a
    0xa2, // t * (b - a)
    0xa0 // a + ...
]);

// 11: perlinGradDot(hash: i32, x: f64, y: f64, z: f64) -> f64
// Vanilla SimplexNoise.GRADIENT 16-entry dot product:
// h = hash & 15
// u = h < 8 ? x : y
// v = h < 4 ? y : (h == 12 || h == 14 ? x : z)
// return ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v)
const bodyPerlinGradDot = makeFuncBody([[1, I32], [2, F64]], [
    0x20, 0x00, 0x41, 15, 0x71, 0x21, 0x04, // local 4 (h) = hash & 15
    // u (local 5) = h < 8 ? x : y
    0x20, 0x01, 0x20, 0x02, 0x20, 0x04, 0x41, 8, 0x48, 0x1b, 0x21, 0x05,
    // v (local 6) = h < 4 ? y : ((h == 12 || h == 14) ? x : z)
    0x20, 0x02,
    0x20, 0x01, 0x20, 0x03,
    0x20, 0x04, 0x41, 12, 0x46,
    0x20, 0x04, 0x41, 14, 0x46,
    0x72, // i32.or
    0x1b, // select x or z
    0x20, 0x04, 0x41, 4, 0x48,
    0x1b, // select y or (x/z)
    0x21, 0x06,
    // ((h & 1) == 0 ? u : -u)
    0x20, 0x05, 0x20, 0x05, 0x9a, // u, -u
    0x20, 0x04, 0x41, 1, 0x71, 0x45, // (h & 1) == 0
    0x1b,
    // ((h & 2) == 0 ? v : -v)
    0x20, 0x06, 0x20, 0x06, 0x9a, // v, -v
    0x20, 0x04, 0x41, 2, 0x71, 0x45, // (h & 2) == 0
    0x1b,
    0xa0 // f64.add
]);

// 12: packVertex(dstByteOffset: i32, x: f32, y: f32, z: f32, u: f32, v: f32, normalPacked: i32, lightPacked: i32, rgbaColor: i32) -> i32
// Writes 32 bytes (8 x 32-bit words) directly into pinned WebAssembly.Memory and returns dstByteOffset + 32
const bodyPackVertex = makeFuncBody([], [
    0x20, 0x00, 0x20, 0x01, 0x38, 0x02, 0x00, // f32.store x at +0
    0x20, 0x00, 0x20, 0x02, 0x38, 0x02, 0x04, // f32.store y at +4
    0x20, 0x00, 0x20, 0x03, 0x38, 0x02, 0x08, // f32.store z at +8
    0x20, 0x00, 0x20, 0x04, 0x38, 0x02, 0x0c, // f32.store u at +12
    0x20, 0x00, 0x20, 0x05, 0x38, 0x02, 0x10, // f32.store v at +16
    0x20, 0x00, 0x20, 0x06, 0x36, 0x02, 0x14, // i32.store normalPacked at +20
    0x20, 0x00, 0x20, 0x07, 0x36, 0x02, 0x18, // i32.store lightPacked at +24
    0x20, 0x00, 0x20, 0x08, 0x36, 0x02, 0x1c, // i32.store rgbaColor at +28
    0x20, 0x00, 0x41, 32, 0x6a // return dstByteOffset + 32
]);

// 13: adler32(ptr: i32, len: i32) -> i32
// Locals: 2: a (i32), 3: b (i32), 4: i (i32)
const bodyAdler32 = makeFuncBody([[3, I32]], [
    0x41, 1, 0x21, 0x02, // a = 1
    0x41, 0, 0x21, 0x03, // b = 0
    0x41, 0, 0x21, 0x04, // i = 0
    0x02, 0x40, // block
    0x03, 0x40, // loop
    0x20, 0x04, 0x20, 0x01, 0x4f, 0x0d, 0x01, // br_if 1 (i >= len)
    // a = (a + mem8[ptr + i]) % 65521
    0x20, 0x02, 0x20, 0x00, 0x20, 0x04, 0x6a, 0x2d, 0x00, 0x00, 0x6a,
    0x41, ...sleb128(65521), 0x70, 0x21, 0x02,
    // b = (b + a) % 65521
    0x20, 0x03, 0x20, 0x02, 0x6a,
    0x41, ...sleb128(65521), 0x70, 0x21, 0x03,
    // i++
    0x20, 0x04, 0x41, 1, 0x6a, 0x21, 0x04,
    0x0c, 0x00, // br 0
    0x0b, // end loop
    0x0b, // end block
    // return (b << 16) | a
    0x20, 0x03, 0x41, 16, 0x74, 0x20, 0x02, 0x72
]);

// 14: writeVarInt(ptr: i32, val: i32) -> i32 (returns bytes written)
// Locals: 2: count (i32)
const bodyWriteVarInt = makeFuncBody([[1, I32]], [
    0x41, 0, 0x21, 0x02, // count = 0
    0x02, 0x40,
    0x03, 0x40,
    // if (val & ~0x7f) == 0 break
    0x20, 0x01, 0x41, ...sleb128(-128), 0x71, 0x45, 0x0d, 0x01,
    // mem8[ptr + count] = (val & 0x7f) | 0x80
    0x20, 0x00, 0x20, 0x02, 0x6a,
    0x20, 0x01, 0x41, ...sleb128(0x7f), 0x71, 0x41, ...sleb128(0x80), 0x72,
    0x3a, 0x00, 0x00,
    // val >>>= 7; count++
    0x20, 0x01, 0x41, 7, 0x76, 0x21, 0x01,
    0x20, 0x02, 0x41, 1, 0x6a, 0x21, 0x02,
    0x0c, 0x00,
    0x0b,
    0x0b,
    // mem8[ptr + count] = val
    0x20, 0x00, 0x20, 0x02, 0x6a, 0x20, 0x01, 0x3a, 0x00, 0x00,
    // return count + 1
    0x20, 0x02, 0x41, 1, 0x6a
]);

// 15: readVarInt(ptr: i32) -> i64 (low 32 bits = value, high 32 bits = bytesRead)
// Locals: 1: result (i32), 2: shift (i32), 3: count (i32), 4: byte (i32)
const bodyReadVarInt = makeFuncBody([[4, I32]], [
    0x02, 0x40,
    0x03, 0x40,
    // byte = mem8[ptr + count]
    0x20, 0x00, 0x20, 0x03, 0x6a, 0x2d, 0x00, 0x00, 0x21, 0x04,
    // result |= (byte & 0x7f) << shift
    0x20, 0x01, 0x20, 0x04, 0x41, ...sleb128(0x7f), 0x71, 0x20, 0x02, 0x74, 0x72, 0x21, 0x01,
    // count++; shift += 7
    0x20, 0x03, 0x41, 1, 0x6a, 0x21, 0x03,
    0x20, 0x02, 0x41, 7, 0x6a, 0x21, 0x02,
    // if (byte & 0x80) != 0 continue
    0x20, 0x04, 0x41, ...sleb128(0x80), 0x71, 0x0d, 0x00,
    0x0b,
    0x0b,
    // return ((count as i64) << 32) | (result as u64)
    0x20, 0x03, 0xad, 0x42, 32, 0x86,
    0x20, 0x01, 0xad, 0x84
]);

const typeSection = section(1, vec(types));
const funcSection = section(3, vec(funcTypes.map(t => uleb128(t))));
// Memory section: 1 memory with min 64 pages (4MB), max 512 pages (32MB)
const memSection = section(5, vec([[0x01, ...uleb128(64), ...uleb128(512)]]));

const exportsList = [
    [...encodeString('memory'), 0x02, 0x00],
    [...encodeString('packBlockPos'), 0x00, 0x00],
    [...encodeString('unpackBlockPosX'), 0x00, 0x01],
    [...encodeString('unpackBlockPosY'), 0x00, 0x02],
    [...encodeString('unpackBlockPosZ'), 0x00, 0x03],
    [...encodeString('xoroInit'), 0x00, 0x04],
    [...encodeString('xoroNextLong'), 0x00, 0x05],
    [...encodeString('xoroNextInt'), 0x00, 0x06],
    [...encodeString('xoroNextFloat'), 0x00, 0x07],
    [...encodeString('xoroNextDouble'), 0x00, 0x08],
    [...encodeString('perlinFade'), 0x00, 0x09],
    [...encodeString('perlinLerp'), 0x00, 0x0a],
    [...encodeString('perlinGradDot'), 0x00, 0x0b],
    [...encodeString('packVertex'), 0x00, 0x0c],
    [...encodeString('adler32'), 0x00, 0x0d],
    [...encodeString('writeVarInt'), 0x00, 0x0e],
    [...encodeString('readVarInt'), 0x00, 0x0f],
];
const exportSection = section(7, vec(exportsList));

const codeSection = section(10, vec([
    bodyPackBlockPos,
    bodyUnpackX,
    bodyUnpackY,
    bodyUnpackZ,
    bodyXoroInit,
    bodyXoroNextLong,
    bodyXoroNextInt,
    bodyXoroNextFloat,
    bodyXoroNextDouble,
    bodyPerlinFade,
    bodyPerlinLerp,
    bodyPerlinGradDot,
    bodyPackVertex,
    bodyAdler32,
    bodyWriteVarInt,
    bodyReadVarInt,
]));

const wasmBytes = Buffer.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...typeSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
    ...codeSection,
]);

const outPath = path.join(__dirname, '../public/assets/mc26_3_core.wasm');
fs.writeFileSync(outPath, wasmBytes);

// Validate compilation and test exports with Node's native WebAssembly engine!
const mod = new WebAssembly.Module(wasmBytes);
const inst = new WebAssembly.Instance(mod);
const ex = inst.exports;

const packed = ex.packBlockPos(-1234, -48, 5678);
const ux = ex.unpackBlockPosX(packed);
const uy = ex.unpackBlockPosY(packed);
const uz = ex.unpackBlockPosZ(packed);
if (ux !== -1234 || uy !== -48 || uz !== 5678) {
    throw new Error(`BlockPos WASM test failed: got (${ux}, ${uy}, ${uz})`);
}

ex.xoroInit(0, 123456789n, 987654321n);
const rLong = ex.xoroNextLong(0);
const rFloat = ex.xoroNextFloat(0);
const rDouble = ex.xoroNextDouble(0);
const fadeVal = ex.perlinFade(0.5);
const nextOff = ex.packVertex(1024, 1.5, 64.0, -2.5, 0.25, 0.75, 0x00ff00, 0x00f000f0, 0xffffffff);

console.log(`[WASM Compiler] Compiled and verified mc26_3_core.wasm (${wasmBytes.length} bytes):`);
console.log(`  -> BlockPos(-1234, -48, 5678) = 0x${BigInt.asUintN(64, packed).toString(16)} -> (${ux}, ${uy}, ${uz})`);
console.log(`  -> Xoroshiro128++ nextLong=${rLong}, nextFloat=${rFloat.toFixed(5)}, nextDouble=${rDouble.toFixed(8)}, perlinFade(0.5)=${fadeVal}`);
console.log(`  -> Pinned Vertex Buffer write offset: 1024 -> ${nextOff}`);
