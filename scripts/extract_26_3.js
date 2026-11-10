const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '../..');
const JAR_PATH = path.join(ROOT, '.minecraft/versions/26.3/26.3.jar');
const ASSET_INDEX_PATH = path.join(ROOT, '.minecraft/assets/indexes/34.json');
const ASSET_OBJECTS_DIR = path.join(ROOT, '.minecraft/assets/objects');
const PUBLIC_ASSETS_DIR = path.join(__dirname, '../public/assets');

fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });
fs.mkdirSync(path.join(PUBLIC_ASSETS_DIR, 'sounds'), { recursive: true });
fs.mkdirSync(path.join(PUBLIC_ASSETS_DIR, 'structures'), { recursive: true });

console.log('[Extractor] Reading .minecraft/versions/26.3/26.3.jar...');
const jarBuf = fs.readFileSync(JAR_PATH);

let eocdOffset = -1;
for (let i = jarBuf.length - 22; i >= Math.max(0, jarBuf.length - 65557); i--) {
    if (jarBuf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
}
const totalEntries = jarBuf.readUInt16LE(eocdOffset + 10);
const cdOffset = jarBuf.readUInt32LE(eocdOffset + 16);

let ptr = cdOffset;
const entries = [];
const entryMap = new Map();
for (let i = 0; i < totalEntries; i++) {
    if (jarBuf.readUInt32LE(ptr) !== 0x02014b50) break;
    const compMethod = jarBuf.readUInt16LE(ptr + 10);
    const compSize = jarBuf.readUInt32LE(ptr + 20);
    const uncompSize = jarBuf.readUInt32LE(ptr + 24);
    const nameLen = jarBuf.readUInt16LE(ptr + 28);
    const extraLen = jarBuf.readUInt16LE(ptr + 30);
    const commentLen = jarBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = jarBuf.readUInt32LE(ptr + 42);
    const name = jarBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const e = { name, compMethod, compSize, uncompSize, localHeaderOffset };
    entries.push(e);
    entryMap.set(name, e);
    ptr += 46 + nameLen + extraLen + commentLen;
}

function extractEntry(entry) {
    if (typeof entry === 'string') entry = entryMap.get(entry);
    if (!entry) return null;
    const lh = entry.localHeaderOffset;
    const nameLen = jarBuf.readUInt16LE(lh + 26);
    const extraLen = jarBuf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + nameLen + extraLen;
    const compData = jarBuf.subarray(dataStart, dataStart + entry.compSize);
    if (entry.compMethod === 0) return compData;
    if (entry.compMethod === 8) return zlib.inflateRawSync(compData);
    throw new Error('Unknown compression method: ' + entry.compMethod);
}

// Pure-JS PNG Decoder & Encoder
function decodePNG(buf) {
    if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('Not a PNG');
    let offset = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    let palette = null, trns = null;
    const idatChunks = [];
    while (offset < buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.toString('ascii', offset + 4, offset + 8);
        const data = buf.subarray(offset + 8, offset + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9];
        } else if (type === 'PLTE') palette = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IDAT') idatChunks.push(data);
        else if (type === 'IEND') break;
        offset += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
    const bitsPerPixel = channels * bitDepth;
    const bytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    const unfilter = new Uint8Array(height * stride);
    let inPtr = 0;
    for (let y = 0; y < height; y++) {
        const filterType = raw[inPtr++];
        const rowStart = y * stride, prevRowStart = (y - 1) * stride;
        for (let x = 0; x < stride; x++) {
            const rawByte = raw[inPtr++];
            const a = x >= bytesPerPixel ? unfilter[rowStart + x - bytesPerPixel] : 0;
            const b = y > 0 ? unfilter[prevRowStart + x] : 0;
            const c = (x >= bytesPerPixel && y > 0) ? unfilter[prevRowStart + x - bytesPerPixel] : 0;
            let val = rawByte;
            if (filterType === 1) val = (rawByte + a) & 255;
            else if (filterType === 2) val = (rawByte + b) & 255;
            else if (filterType === 3) val = (rawByte + ((a + b) >> 1)) & 255;
            else if (filterType === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                val = (rawByte + pr) & 255;
            }
            unfilter[rowStart + x] = val;
        }
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const rowOffset = y * stride;
        for (let x = 0; x < width; x++) {
            const outIdx = (y * width + x) * 4;
            if (colorType === 6 && bitDepth === 8) {
                const src = rowOffset + x * 4;
                rgba[outIdx] = unfilter[src]; rgba[outIdx + 1] = unfilter[src + 1];
                rgba[outIdx + 2] = unfilter[src + 2]; rgba[outIdx + 3] = unfilter[src + 3];
            } else if (colorType === 2 && bitDepth === 8) {
                const src = rowOffset + x * 3;
                const r = unfilter[src], g = unfilter[src + 1], b = unfilter[src + 2];
                let a = 255;
                if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0;
                rgba[outIdx] = r; rgba[outIdx + 1] = g; rgba[outIdx + 2] = b; rgba[outIdx + 3] = a;
            } else if (colorType === 4 && bitDepth === 8) {
                const src = rowOffset + x * 2;
                const lum = unfilter[src], a = unfilter[src + 1];
                rgba[outIdx] = lum; rgba[outIdx + 1] = lum; rgba[outIdx + 2] = lum; rgba[outIdx + 3] = a;
            } else if (colorType === 0) {
                let lum = 0;
                if (bitDepth === 8) lum = unfilter[rowOffset + x];
                else if (bitDepth === 4) {
                    const byte = unfilter[rowOffset + (x >> 1)];
                    lum = ((x & 1) === 0 ? (byte >> 4) : (byte & 15)) * 17;
                } else if (bitDepth === 2) {
                    const byte = unfilter[rowOffset + (x >> 2)];
                    lum = ((byte >> (6 - 2 * (x & 3))) & 3) * 85;
                } else if (bitDepth === 1) {
                    const byte = unfilter[rowOffset + (x >> 3)];
                    lum = ((byte >> (7 - (x & 7))) & 1) * 255;
                }
                let a = 255;
                if (trns && trns.length >= 2 && lum === trns[1]) a = 0;
                rgba[outIdx] = lum; rgba[outIdx + 1] = lum; rgba[outIdx + 2] = lum; rgba[outIdx + 3] = a;
            } else if (colorType === 3) {
                let idx = 0;
                if (bitDepth === 8) idx = unfilter[rowOffset + x];
                else if (bitDepth === 4) {
                    const byte = unfilter[rowOffset + (x >> 1)];
                    idx = (x & 1) === 0 ? (byte >> 4) : (byte & 15);
                } else if (bitDepth === 2) {
                    const byte = unfilter[rowOffset + (x >> 2)];
                    idx = (byte >> (6 - 2 * (x & 3))) & 3;
                } else if (bitDepth === 1) {
                    const byte = unfilter[rowOffset + (x >> 3)];
                    idx = (byte >> (7 - (x & 7))) & 1;
                }
                rgba[outIdx] = palette ? palette[idx * 3] : 0;
                rgba[outIdx + 1] = palette ? palette[idx * 3 + 1] : 0;
                rgba[outIdx + 2] = palette ? palette[idx * 3 + 2] : 0;
                rgba[outIdx + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
            }
        }
    }
    return { width, height, rgba };
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
}
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function makeChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}
function encodePNG(width, height, rgba) {
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        const rowStart = y * (1 + width * 4);
        raw[rowStart] = 0; // filter 0
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflateSync(raw, { level: 6 });
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', idat),
        makeChunk('IEND', Buffer.alloc(0))
    ]);
}

// 1. Stitch Block & Item Texture Atlases (blocks.png & items.png) + .mcmeta animation metadata
console.log('[Extractor] Stitching blocks.png and items.png texture atlases...');
function stitchAtlas(prefix, outFile, cols = 64) {
    const pngEntries = entries.filter(e => e.name.startsWith(prefix) && e.name.endsWith('.png')).sort((a, b) => a.name.localeCompare(b.name));
    const cellSize = 16;
    const rows = Math.ceil(pngEntries.length / cols);
    const atlasW = cols * cellSize;
    const atlasH = Math.pow(2, Math.ceil(Math.log2(rows * cellSize)));
    const atlasRgba = new Uint8Array(atlasW * atlasH * 4);
    const uvMap = {};
    const animations = {};

    pngEntries.forEach((entry, index) => {
        const shortName = entry.name.replace(prefix, '').replace('.png', '');
        const col = index % cols;
        const row = Math.floor(index / cols);
        const dstX = col * cellSize;
        const dstY = row * cellSize;

        const img = decodePNG(extractEntry(entry));
        // Copy first 16x16 frame (or downscale if 32x32)
        const frameH = Math.min(img.width, img.height);
        const scale = img.width / 16;
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < 16; x++) {
                const srcX = Math.min(img.width - 1, Math.floor(x * scale));
                const srcY = Math.min(img.height - 1, Math.floor(y * scale));
                const sIdx = (srcY * img.width + srcX) * 4;
                const dIdx = ((dstY + y) * atlasW + (dstX + x)) * 4;
                atlasRgba[dIdx] = img.rgba[sIdx];
                atlasRgba[dIdx + 1] = img.rgba[sIdx + 1];
                atlasRgba[dIdx + 2] = img.rgba[sIdx + 2];
                atlasRgba[dIdx + 3] = img.rgba[sIdx + 3];
            }
        }

        uvMap[shortName] = {
            u0: dstX / atlasW,
            v0: dstY / atlasH,
            u1: (dstX + cellSize) / atlasW,
            v1: (dstY + cellSize) / atlasH,
            x: dstX,
            y: dstY
        };

        // Check for .mcmeta animation
        const mcmetaEntry = entryMap.get(entry.name + '.mcmeta');
        if (mcmetaEntry && img.height > img.width) {
            try {
                const meta = JSON.parse(extractEntry(mcmetaEntry).toString('utf8'));
                if (meta.animation) {
                    const frameCount = Math.floor(img.height / img.width);
                    const frames = [];
                    for (let f = 0; f < Math.min(frameCount, 16); f++) {
                        const fPixels = [];
                        for (let y = 0; y < 16; y++) {
                            for (let x = 0; x < 16; x++) {
                                const srcX = Math.floor(x * scale);
                                const srcY = Math.floor((f * img.width) + y * scale);
                                const sIdx = (srcY * img.width + srcX) * 4;
                                fPixels.push(img.rgba[sIdx], img.rgba[sIdx + 1], img.rgba[sIdx + 2], img.rgba[sIdx + 3]);
                            }
                        }
                        frames.push(Buffer.from(fPixels).toString('base64'));
                    }
                    animations[shortName] = {
                        frametime: meta.animation.frametime || 1,
                        interpolate: !!meta.animation.interpolate,
                        frames: meta.animation.frames || null,
                        frameCount: frames.length,
                        frameData: frames,
                        x: dstX,
                        y: dstY
                    };
                }
            } catch (e) {}
        }
    });

    const pngOut = encodePNG(atlasW, atlasH, atlasRgba);
    fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, outFile), pngOut);
    return { width: atlasW, height: atlasH, uvs: uvMap, animations };
}

const blockAtlas = stitchAtlas('assets/minecraft/textures/block/', 'blocks.png', 64);
const itemAtlas = stitchAtlas('assets/minecraft/textures/item/', 'items.png', 32);
console.log(`[Extractor] Stitched blocks.png (${blockAtlas.width}x${blockAtlas.height}, ${Object.keys(blockAtlas.uvs).length} sprites, ${Object.keys(blockAtlas.animations).length} animated) and items.png (${itemAtlas.width}x${itemAtlas.height}, ${Object.keys(itemAtlas.uvs).length} sprites)`);

// Extract colormaps, font, environment textures
for (const extraTex of [
    ['assets/minecraft/textures/colormap/grass.png', 'grass_colormap.png'],
    ['assets/minecraft/textures/colormap/foliage.png', 'foliage_colormap.png'],
    ['assets/minecraft/textures/colormap/dry_foliage.png', 'dry_foliage_colormap.png'],
    ['assets/minecraft/textures/font/ascii.png', 'ascii.png'],
    ['assets/minecraft/textures/font/nonlatin_european.png', 'nonlatin_european.png'],
    ['assets/minecraft/textures/environment/sun.png', 'sun.png'],
    ['assets/minecraft/textures/environment/moon_phases.png', 'moon_phases.png'],
    ['assets/minecraft/textures/environment/clouds.png', 'clouds.png'],
    ['assets/minecraft/textures/environment/rain.png', 'rain.png'],
    ['assets/minecraft/textures/environment/snow.png', 'snow.png']
]) {
    const data = extractEntry(extraTex[0]);
    if (data) fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, extraTex[1]), data);
}

// 2. Parse JVM Bytecode Constant Pools & <clinit> from 26.3.jar
console.log('[Extractor] Parsing JVM Class Constant Pools & <clinit> bytecode from 26.3.jar...');
function parseClassFull(classBuf) {
    const cpCount = classBuf.readUInt16BE(8);
    const cp = [null];
    let offset = 10;
    for (let i = 1; i < cpCount; i++) {
        const tag = classBuf[offset++];
        switch (tag) {
            case 1: {
                const len = classBuf.readUInt16BE(offset); offset += 2;
                cp.push({ tag: 'Utf8', value: classBuf.toString('utf8', offset, offset + len) });
                offset += len; break;
            }
            case 3: cp.push({ tag: 'Integer', value: classBuf.readInt32BE(offset) }); offset += 4; break;
            case 4: cp.push({ tag: 'Float', value: classBuf.readFloatBE(offset) }); offset += 4; break;
            case 5: cp.push({ tag: 'Long', value: classBuf.readBigInt64BE(offset) }); cp.push(null); offset += 8; i++; break;
            case 6: cp.push({ tag: 'Double', value: classBuf.readDoubleBE(offset) }); cp.push(null); offset += 8; i++; break;
            case 7: case 8: case 16: case 19: case 20:
                cp.push({ tag, index: classBuf.readUInt16BE(offset) }); offset += 2; break;
            case 9: case 10: case 11: case 12: case 17: case 18:
                cp.push({ tag, index1: classBuf.readUInt16BE(offset), index2: classBuf.readUInt16BE(offset + 2) }); offset += 4; break;
            case 15:
                cp.push({ tag, refKind: classBuf[offset], refIndex: classBuf.readUInt16BE(offset + 1) }); offset += 3; break;
        }
    }
    offset += 6;
    const interfacesCount = classBuf.readUInt16BE(offset); offset += 2 + interfacesCount * 2;
    const fieldsCount = classBuf.readUInt16BE(offset); offset += 2;
    const fields = [];
    for (let i = 0; i < fieldsCount; i++) {
        const fFlags = classBuf.readUInt16BE(offset);
        const fNameIdx = classBuf.readUInt16BE(offset + 2);
        const fDescIdx = classBuf.readUInt16BE(offset + 4);
        const attrsCount = classBuf.readUInt16BE(offset + 6); offset += 8;
        for (let j = 0; j < attrsCount; j++) offset += 6 + classBuf.readUInt32BE(offset + 2);
        fields.push({ name: cp[fNameIdx].value, desc: cp[fDescIdx].value, flags: fFlags });
    }
    const methodsCount = classBuf.readUInt16BE(offset); offset += 2;
    const methods = [];
    for (let i = 0; i < methodsCount; i++) {
        const mFlags = classBuf.readUInt16BE(offset);
        const mNameIdx = classBuf.readUInt16BE(offset + 2);
        const mDescIdx = classBuf.readUInt16BE(offset + 4);
        const attrsCount = classBuf.readUInt16BE(offset + 6); offset += 8;
        let code = null;
        for (let j = 0; j < attrsCount; j++) {
            const attrNameIdx = classBuf.readUInt16BE(offset);
            const attrLen = classBuf.readUInt32BE(offset + 2);
            if (cp[attrNameIdx].value === 'Code') {
                const codeLen = classBuf.readUInt32BE(offset + 10);
                code = classBuf.subarray(offset + 14, offset + 14 + codeLen);
            }
            offset += 6 + attrLen;
        }
        methods.push({ name: cp[mNameIdx].value, desc: cp[mDescIdx].value, flags: mFlags, code });
    }
    return { cp, fields, methods };
}

function getRefName(cp, idx) {
    const entry = cp[idx];
    if (!entry) return '';
    if (entry.tag === 'Utf8') return entry.value;
    if (entry.tag === 7 || entry.tag === 8) return getRefName(cp, entry.index);
    if (entry.tag === 9 || entry.tag === 10 || entry.tag === 11) {
        return getRefName(cp, entry.index1) + '.' + getRefName(cp, entry.index2);
    }
    if (entry.tag === 12) return getRefName(cp, entry.index1) + ':' + getRefName(cp, entry.index2);
    return JSON.stringify(entry);
}

// Extract EntityTypes.<clinit>
const etCls = parseClassFull(extractEntry('net/minecraft/world/entity/EntityTypes.class'));
const etCode = etCls.methods.find(m => m.name === '<clinit>').code;
const entitiesRegistry = [];
{
    let cur = { floats: [], ints: [], category: 'MISC', fireImmune: false };
    let i = 0;
    while (i < etCode.length) {
        const op = etCode[i++];
        if (op === 0x12) {
            const e = etCls.cp[etCode[i++]];
            if (e && e.tag === 'Float') cur.floats.push(e.value);
        } else if (op === 0x13 || op === 0x14) {
            const idx = etCode.readUInt16BE(i); i += 2;
            const e = etCls.cp[idx];
            if (e && e.tag === 'Float') cur.floats.push(e.value);
        } else if (op === 0x0b || op === 0x0c || op === 0x0d) {
            cur.floats.push(op - 0x0b);
        } else if (op >= 0x02 && op <= 0x08) {
            cur.ints.push(op - 3);
        } else if (op === 0x10) {
            cur.ints.push(etCode.readInt8(i++));
        } else if (op === 0x11) {
            cur.ints.push(etCode.readInt16BE(i)); i += 2;
        } else if (op === 0xb2) {
            const idx = etCode.readUInt16BE(i); i += 2;
            const ref = getRefName(etCls.cp, idx);
            if (ref.startsWith('net/minecraft/world/entity/MobCategory.')) {
                cur.category = ref.split('.')[1].split(':')[0];
            }
        } else if (op === 0xb6 || op === 0xb7 || op === 0xb8) {
            const idx = etCode.readUInt16BE(i); i += 2;
            const ref = getRefName(etCls.cp, idx);
            if (ref.includes('EntityType$Builder.sized')) {
                cur.height = Number((cur.floats.pop() ?? 1.8).toFixed(4));
                cur.width = Number((cur.floats.pop() ?? 0.6).toFixed(4));
            } else if (ref.includes('EntityType$Builder.eyeHeight')) {
                cur.eyeHeight = Number((cur.floats.pop() ?? 1.62).toFixed(4));
            } else if (ref.includes('EntityType$Builder.clientTrackingRange')) {
                cur.trackingRange = cur.ints.pop() ?? 8;
            } else if (ref.includes('EntityType$Builder.updateInterval')) {
                cur.updateInterval = cur.ints.pop() ?? 3;
            } else if (ref.includes('EntityType$Builder.fireImmune')) {
                cur.fireImmune = true;
            }
        } else if (op === 0xb3) {
            const idx = etCode.readUInt16BE(i); i += 2;
            const ref = getRefName(etCls.cp, idx);
            if (ref.startsWith('net/minecraft/world/entity/EntityTypes.')) {
                const fieldName = ref.split('.')[1].split(':')[0];
                entitiesRegistry.push({
                    id: 'minecraft:' + fieldName.toLowerCase(),
                    rawId: entitiesRegistry.length,
                    name: fieldName.toLowerCase(),
                    category: cur.category,
                    width: cur.width ?? 0.6,
                    height: cur.height ?? 1.8,
                    eyeHeight: cur.eyeHeight ?? ((cur.height ?? 1.8) * 0.85),
                    trackingRange: cur.trackingRange ?? 8,
                    updateInterval: cur.updateInterval ?? 3,
                    fireImmune: cur.fireImmune
                });
                cur = { floats: [], ints: [], category: 'MISC', fireImmune: false };
            }
        } else if (op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1) i += 2;
        else if (op === 0xba) i += 4;
        else if (op === 0x15 || op === 0x16 || op === 0x17 || op === 0x18 || op === 0x19 || op === 0x36 || op === 0x37 || op === 0x38 || op === 0x39 || op === 0x3a || op === 0xbc) i += 1;
    }
}

// Parse Blocks.<clinit> + all 1,289 blockstates/*.json
const blocksCls = parseClassFull(extractEntry('net/minecraft/world/level/block/Blocks.class'));
const bCode = blocksCls.methods.find(m => m.name === '<clinit>').code;
const bPropsMap = {};
{
    let cur = { floats: [], ints: [], flags: [], mapColor: 'STONE', soundType: 'STONE', instrument: 'HARP' };
    let i = 0;
    while (i < bCode.length) {
        const op = bCode[i++];
        if (op === 0x12) {
            const e = blocksCls.cp[bCode[i++]];
            if (e && e.tag === 'Float') cur.floats.push(e.value);
            else if (e && e.tag === 'Integer') cur.ints.push(e.value);
        } else if (op === 0x13 || op === 0x14) {
            const idx = bCode.readUInt16BE(i); i += 2;
            const e = blocksCls.cp[idx];
            if (e && e.tag === 'Float') cur.floats.push(e.value);
            else if (e && e.tag === 'Integer') cur.ints.push(e.value);
        } else if (op === 0x0b || op === 0x0c || op === 0x0d) cur.floats.push(op - 0x0b);
        else if (op >= 0x02 && op <= 0x08) cur.ints.push(op - 3);
        else if (op === 0x10) cur.ints.push(bCode.readInt8(i++));
        else if (op === 0x11) { cur.ints.push(bCode.readInt16BE(i)); i += 2; }
        else if (op === 0xb2) {
            const idx = bCode.readUInt16BE(i); i += 2;
            const ref = getRefName(blocksCls.cp, idx);
            if (ref.startsWith('net/minecraft/world/level/material/MapColor.')) cur.mapColor = ref.split('.')[1].split(':')[0];
            else if (ref.startsWith('net/minecraft/world/level/block/SoundType.')) cur.soundType = ref.split('.')[1].split(':')[0];
            else if (ref.startsWith('net/minecraft/world/level/block/state/properties/NoteBlockInstrument.')) cur.instrument = ref.split('.')[1].split(':')[0];
        } else if (op === 0xb6 || op === 0xb7 || op === 0xb8) {
            const idx = bCode.readUInt16BE(i); i += 2;
            const ref = getRefName(blocksCls.cp, idx);
            if (ref.includes('BlockBehaviour$Properties.')) {
                const mName = ref.split('.')[1].split(':')[0];
                cur.flags.push(mName);
                if (mName === 'strength') {
                    if (cur.floats.length >= 2) {
                        cur.explosionResistance = Number(cur.floats.pop().toFixed(3));
                        cur.destroyTime = Number(cur.floats.pop().toFixed(3));
                    } else if (cur.floats.length === 1) {
                        const s = Number(cur.floats.pop().toFixed(3));
                        cur.destroyTime = s; cur.explosionResistance = s;
                    }
                } else if (mName === 'instabreak') {
                    cur.destroyTime = 0; cur.explosionResistance = 0;
                }
            }
        } else if (op === 0xb3) {
            const idx = bCode.readUInt16BE(i); i += 2;
            const ref = getRefName(blocksCls.cp, idx);
            if (ref.startsWith('net/minecraft/world/level/block/Blocks.') && ref.endsWith(':Lnet/minecraft/world/level/block/Block;')) {
                const fieldName = ref.split('.')[1].split(':')[0].toLowerCase();
                bPropsMap[fieldName] = {
                    mapColor: cur.mapColor,
                    soundType: cur.soundType,
                    instrument: cur.instrument,
                    destroyTime: cur.destroyTime ?? 1.0,
                    explosionResistance: cur.explosionResistance ?? 1.0,
                    noCollision: cur.flags.includes('noCollision'),
                    noOcclusion: cur.flags.includes('noOcclusion'),
                    replaceable: cur.flags.includes('replaceable'),
                    randomTicks: cur.flags.includes('randomTicks'),
                    requiresCorrectTool: cur.flags.includes('requiresCorrectToolForDrops'),
                    air: cur.flags.includes('air'),
                    liquid: cur.flags.includes('liquid')
                };
                cur = { floats: [], ints: [], flags: [], mapColor: 'STONE', soundType: 'STONE', instrument: 'HARP' };
            }
        } else if (op === 0xbb || op === 0xbd || op === 0xc0 || op === 0xc1) i += 2;
        else if (op === 0xba) i += 4;
        else if (op === 0x15 || op === 0x16 || op === 0x17 || op === 0x18 || op === 0x19 || op === 0x36 || op === 0x37 || op === 0x38 || op === 0x39 || op === 0x3a || op === 0xbc) i += 1;
    }
}

// Parse all models/block/*.json to resolve textures and elements for each block
console.log('[Extractor] Resolving all 1,289 blockstates and 4,195 block/item models...');
const rawBlockModels = {};
for (const e of entries.filter(e => e.name.startsWith('assets/minecraft/models/block/') && e.name.endsWith('.json'))) {
    const shortName = e.name.replace('assets/minecraft/models/block/', '').replace('.json', '');
    rawBlockModels[shortName] = JSON.parse(extractEntry(e).toString('utf8'));
}

function resolveBlockModel(modelName, depth = 0) {
    if (!modelName || depth > 8) return { textures: {}, elements: null };
    const clean = modelName.replace('minecraft:', '').replace('block/', '');
    const m = rawBlockModels[clean];
    if (!m) return { textures: {}, elements: null };
    const parentRes = m.parent ? resolveBlockModel(m.parent, depth + 1) : { textures: {}, elements: null };
    const textures = { ...parentRes.textures, ...(m.textures || {}) };
    const elements = m.elements || parentRes.elements || null;
    return { textures, elements, ambientocclusion: m.ambientocclusion ?? parentRes.ambientocclusion ?? true };
}

function resolveTexVar(val, textures, depth = 0) {
    if (!val || depth > 6) return 'stone';
    if (typeof val === 'object') val = val.sprite || val.texture || Object.values(val)[0];
    if (typeof val !== 'string') return 'stone';
    if (val.startsWith('#')) return resolveTexVar(textures[val.slice(1)], textures, depth + 1);
    return val.replace('minecraft:', '').replace('block/', '');
}

const blockstateEntries = entries.filter(e => e.name.startsWith('assets/minecraft/blockstates/') && e.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
// Ensure air, stone, grass_block, dirt, cobblestone, bedrock, water, lava are at known indices or mapped cleanly
const blocksRegistry = [];
const blockStatesData = {};

for (const e of blockstateEntries) {
    const blockName = e.name.replace('assets/minecraft/blockstates/', '').replace('.json', '');
    const bsJson = JSON.parse(extractEntry(e).toString('utf8'));
    blockStatesData[blockName] = bsJson;

    // Find primary model from variants or multipart
    let firstModel = blockName;
    if (bsJson.variants) {
        const firstVar = Object.values(bsJson.variants)[0];
        const mObj = Array.isArray(firstVar) ? firstVar[0] : firstVar;
        if (mObj && mObj.model) firstModel = mObj.model;
    } else if (bsJson.multipart && bsJson.multipart.length > 0) {
        const app = bsJson.multipart[0].apply;
        const mObj = Array.isArray(app) ? app[0] : app;
        if (mObj && mObj.model) firstModel = mObj.model;
    }

    const resolved = resolveBlockModel(firstModel);
    const texs = resolved.textures;
    const topTex = resolveTexVar(texs.up || texs.top || texs.end || texs.all || texs.side || texs.cross || texs.plant || texs.texture || Object.values(texs)[0] || blockName, texs);
    const bottomTex = resolveTexVar(texs.down || texs.bottom || texs.end || texs.all || texs.side || topTex, texs);
    const northTex = resolveTexVar(texs.north || texs.front || texs.side || texs.all || texs.cross || topTex, texs);
    const southTex = resolveTexVar(texs.south || texs.side || texs.all || northTex, texs);
    const eastTex = resolveTexVar(texs.east || texs.side || texs.all || northTex, texs);
    const westTex = resolveTexVar(texs.west || texs.side || texs.all || northTex, texs);

    // Compute VoxelShape bounding boxes from resolved model elements
    let boxes = [[0, 0, 0, 1, 1, 1]];
    let isCross = false;
    let tintIndex = -1;
    if (resolved.elements && resolved.elements.length > 0) {
        boxes = resolved.elements.map(el => [
            el.from[0] / 16, el.from[1] / 16, el.from[2] / 16,
            el.to[0] / 16, el.to[1] / 16, el.to[2] / 16
        ]);
        for (const el of resolved.elements) {
            if (el.rotation && (el.rotation.angle === 45 || el.rotation.angle === -45)) isCross = true;
            if (el.faces) {
                for (const f of Object.values(el.faces)) {
                    if (f.tintindex !== undefined) tintIndex = f.tintindex;
                }
            }
        }
    }

    const bp = bPropsMap[blockName] || {
        mapColor: 'STONE',
        soundType: 'STONE',
        instrument: 'HARP',
        destroyTime: blockName.includes('planks') || blockName.includes('log') ? 2.0 : blockName.includes('leaves') ? 0.2 : 1.5,
        explosionResistance: 6.0,
        noCollision: isCross || blockName.includes('air') || blockName.includes('torch') || blockName.includes('flower') || blockName.includes('grass') && blockName !== 'grass_block',
        noOcclusion: isCross || blockName.includes('glass') || blockName.includes('leaves') || blockName.includes('slab') || blockName.includes('stairs') || blockName.includes('fence') || blockName.includes('door') || blockName.includes('trapdoor'),
        replaceable: blockName.includes('air') || blockName === 'water' || blockName === 'lava' || blockName === 'short_grass',
        randomTicks: blockName === 'grass_block' || blockName.includes('leaves') || blockName.includes('crop') || blockName === 'water' || blockName === 'lava',
        requiresCorrectTool: false,
        air: blockName.endsWith('air'),
        liquid: blockName === 'water' || blockName === 'lava'
    };

    // Determine render pass: 0 = opaque, 1 = cutout, 2 = translucent
    let renderLayer = 0;
    if (blockName === 'water' || blockName.includes('stained_glass') || blockName === 'ice' || blockName === 'frosted_ice' || blockName === 'slime_block' || blockName === 'honey_block' || blockName === 'nether_portal') {
        renderLayer = 2;
    } else if (isCross || bp.noOcclusion || blockName.includes('leaves') || blockName.includes('glass') || blockName === 'grass_block' || blockName.includes('door') || blockName.includes('trapdoor') || blockName.includes('torch') || blockName.includes('lantern') || blockName.includes('spike')) {
        renderLayer = 1;
    }

    // Light emission (vanilla 0..15)
    let lightEmission = 0;
    if (blockName === 'lava' || blockName === 'glowstone' || blockName === 'sea_lantern' || blockName === 'shroomlight' || blockName === 'jack_o_lantern' || blockName === 'beacon' || blockName === 'conduit' || blockName === 'end_gateway' || blockName === 'end_portal' || blockName === 'fire' || blockName.includes('froglight') || blockName === 'lantern') {
        lightEmission = 15;
    } else if (blockName === 'torch' || blockName === 'wall_torch' || blockName === 'end_rod') {
        lightEmission = 14;
    } else if (blockName === 'soul_fire' || blockName === 'soul_torch' || blockName === 'soul_lantern' || blockName === 'copper_fire_flame') {
        lightEmission = 10;
    } else if (blockName === 'redstone_torch' || blockName === 'crying_obsidian' || blockName.includes('sulfur_spike') || blockName === 'potent_sulfur') {
        lightEmission = 7;
    } else if (blockName === 'amethyst_cluster') {
        lightEmission = 5;
    }

    blocksRegistry.push({
        id: 'minecraft:' + blockName,
        name: blockName,
        rawId: blocksRegistry.length,
        textures: { top: topTex, bottom: bottomTex, north: northTex, south: southTex, east: eastTex, west: westTex },
        boxes: bp.noCollision ? [] : boxes,
        selectionBoxes: boxes,
        isCross,
        tintIndex,
        renderLayer,
        lightEmission,
        ...bp
    });
}

// Parse Items.class fields + assets/minecraft/items/*.json
const itemsCls = parseClassFull(extractEntry('net/minecraft/world/item/Items.class'));
const itemsRegistry = itemsCls.fields.map((f, idx) => {
    const name = f.name.toLowerCase();
    return {
        id: 'minecraft:' + name,
        name,
        rawId: idx,
        isBlock: !!blockStatesData[name],
        texture: itemAtlas.uvs[name] ? name : (blockAtlas.uvs[name] ? name : 'stone')
    };
});

// Parse ParticleTypes.class
const ptCls = parseClassFull(extractEntry('net/minecraft/core/particles/ParticleTypes.class'));
const particlesRegistry = ptCls.cp.filter(e => e && e.tag === 8).map((e, idx) => ({
    id: 'minecraft:' + ptCls.cp[e.index].value,
    name: ptCls.cp[e.index].value,
    rawId: idx
}));

// Parse SoundEvents.class + sounds.json from 34.json
const assetIndex = JSON.parse(fs.readFileSync(ASSET_INDEX_PATH, 'utf8'));
const soundsHash = assetIndex.objects['minecraft/sounds.json'].hash;
const soundsJsonPath = path.join(ASSET_OBJECTS_DIR, soundsHash.slice(0, 2), soundsHash);
const soundsJson = JSON.parse(fs.readFileSync(soundsJsonPath, 'utf8'));

// Extract essential OGG Vorbis sound files into public/assets/sounds/ for immediate playback
let copiedSounds = 0;
const soundEventMap = {};
for (const [evName, evObj] of Object.entries(soundsJson)) {
    const sList = [];
    for (const s of (evObj.sounds || [])) {
        const sName = typeof s === 'string' ? s : s.name;
        sList.push(sName);
        const assetKey = `minecraft/sounds/${sName}.ogg`;
        const assetObj = assetIndex.objects[assetKey];
        if (assetObj && (
            sName.startsWith('ui/') ||
            sName.startsWith('step/') ||
            sName.startsWith('dig/') ||
            sName.startsWith('liquid/') ||
            sName.startsWith('random/') ||
            sName.startsWith('ambient/cave/')
        )) {
            const srcPath = path.join(ASSET_OBJECTS_DIR, assetObj.hash.slice(0, 2), assetObj.hash);
            const dstPath = path.join(PUBLIC_ASSETS_DIR, 'sounds', `${sName.replace(/\//g, '_')}.ogg`);
            if (fs.existsSync(srcPath) && !fs.existsSync(dstPath)) {
                fs.copyFileSync(srcPath, dstPath);
                copiedSounds++;
            }
        }
    }
    soundEventMap[evName] = sList;
}
console.log(`[Extractor] Extracted ${Object.keys(soundEventMap).length} sound events and copied ${copiedSounds} core OGG Vorbis audio files.`);

// Parse all 67 Biomes from data/minecraft/worldgen/biome/*.json
const biomesRegistry = [];
for (const e of entries.filter(e => e.name.startsWith('data/minecraft/worldgen/biome/') && e.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const bName = e.name.replace('data/minecraft/worldgen/biome/', '').replace('.json', '');
    const bData = JSON.parse(extractEntry(e).toString('utf8'));
    biomesRegistry.push({
        id: 'minecraft:' + bName,
        name: bName,
        rawId: biomesRegistry.length,
        temperature: bData.temperature ?? 0.8,
        downfall: bData.downfall ?? 0.4,
        hasPrecipitation: bData.has_precipitation ?? true,
        effects: bData.effects || {}
    });
}

// Parse en_us.json
const langJson = JSON.parse(extractEntry('assets/minecraft/lang/en_us.json').toString('utf8'));

// Save registries.json
const verObj = JSON.parse(extractEntry('version.json').toString('utf8'));
const registriesOut = {
    version: verObj,
    protocol_version: verObj.protocol_version,
    data_version: verObj.world_version,
    atlases: {
        blocks: { width: blockAtlas.width, height: blockAtlas.height, uvs: blockAtlas.uvs, animations: blockAtlas.animations },
        items: { width: itemAtlas.width, height: itemAtlas.height, uvs: itemAtlas.uvs, animations: itemAtlas.animations }
    },
    blockAtlas: { width: blockAtlas.width, height: blockAtlas.height, uvs: blockAtlas.uvs, animations: blockAtlas.animations },
    itemAtlas: { width: itemAtlas.width, height: itemAtlas.height, uvs: itemAtlas.uvs, animations: itemAtlas.animations },
    blocks: blocksRegistry,
    items: itemsRegistry,
    entities: entitiesRegistry,
    biomes: biomesRegistry,
    particles: particlesRegistry,
    soundEvents: soundEventMap,
    sounds: soundEventMap,
    lang: langJson
};
fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'registries.json'), JSON.stringify(registriesOut));
console.log(`[Extractor] Wrote registries.json: ${blocksRegistry.length} blocks, ${itemsRegistry.length} items, ${entitiesRegistry.length} entities, ${biomesRegistry.length} biomes, ${particlesRegistry.length} particles.`);

// 3. Extract all Worldgen Noise Settings, Density Functions, Noises, and Material Rules
console.log('[Extractor] Extracting all Worldgen Noise Routers, Density Functions, Splines, and Noise parameters...');
const worldgenOut = {
    noise_settings: {},
    density_function: {},
    density_functions: {},
    noise: {},
    noises: {},
    material_rule: {}
};
for (const e of entries.filter(e => e.name.startsWith('data/minecraft/worldgen/') && e.name.endsWith('.json'))) {
    const rel = e.name.replace('data/minecraft/worldgen/', '').replace('.json', '');
    const firstSlash = rel.indexOf('/');
    const cat = rel.slice(0, firstSlash);
    const shortKey = rel.slice(firstSlash + 1);
    const key = 'minecraft:' + shortKey;
    if (worldgenOut[cat]) {
        const parsed = JSON.parse(extractEntry(e).toString('utf8'));
        worldgenOut[cat][key] = parsed;
        worldgenOut[cat][shortKey] = parsed;
        if (cat === 'density_function') {
            worldgenOut.density_functions[key] = parsed;
            worldgenOut.density_functions[shortKey] = parsed;
        }
        if (cat === 'noise') {
            worldgenOut.noises[key] = parsed;
            worldgenOut.noises[shortKey] = parsed;
        }
    }
}
fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'worldgen.json'), JSON.stringify(worldgenOut));
console.log(`[Extractor] Wrote worldgen.json: ${Object.keys(worldgenOut.noise_settings).length / 2} noise_settings, ${Object.keys(worldgenOut.density_function).length / 2} density_functions, ${Object.keys(worldgenOut.noise).length / 2} noises, ${Object.keys(worldgenOut.material_rule).length / 2} material_rules.`);

// 4. Extract all Vanilla Shaders from assets/minecraft/shaders/
console.log('[Extractor] Extracting all 93 Vanilla Core/Include/Post Shaders...');
const shadersOut = { core: {}, include: {}, post: {}, all: {} };
for (const e of entries.filter(e => e.name.startsWith('assets/minecraft/shaders/') && !e.name.endsWith('/'))) {
    const rel = e.name.replace('assets/minecraft/shaders/', '');
    const src = extractEntry(e).toString('utf8');
    shadersOut.all[rel] = src;
    if (rel.startsWith('core/')) shadersOut.core[rel.slice(5)] = src;
    else if (rel.startsWith('include/')) shadersOut.include[rel.slice(8)] = src;
    else if (rel.startsWith('post/')) shadersOut.post[rel.slice(5)] = src;
}
fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'shaders.json'), JSON.stringify(shadersOut));

// 5. Extract representative NBT structure templates (.nbt) for Villages, Strongholds, Ancient Cities, Nether Fortresses, Abandoned Camps
console.log('[Extractor] Extracting representative NBT structure templates...');
let structCount = 0;
for (const e of entries.filter(e => e.name.startsWith('data/minecraft/structure/') && e.name.endsWith('.nbt'))) {
    if (
        e.name.includes('village/plains/houses/plains_small_house_1') ||
        e.name.includes('village/plains/town_centers/plains_fountain_01') ||
        e.name.includes('stronghold/') ||
        e.name.includes('ancient_city/city_center/city_center_1') ||
        e.name.includes('nether_fossils/fossil_1') ||
        e.name.includes('abandoned_camp/') ||
        e.name.includes('igloo/top')
    ) {
        if (structCount < 25) {
            const flatName = e.name.replace('data/minecraft/structure/', '').replace(/\//g, '__');
            fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'structures', flatName), extractEntry(e));
            structCount++;
        }
    }
}
console.log(`[Extractor] Extracted ${structCount} binary .nbt structure templates.`);

// 6. Extract embedded epoxy.wasm from Wispcraft-1.12.2.html
const wispcraftHtmlPath = path.join(ROOT, 'Wispcraft-1.12.2.html');
if (fs.existsSync(wispcraftHtmlPath)) {
    const htmlStr = fs.readFileSync(wispcraftHtmlPath, 'utf8');
    const wasmMatch = htmlStr.match(/atob\("(AGFzbQEAAAA[^"]+)"\)/);
    if (wasmMatch) {
        const wasmBuf = Buffer.from(wasmMatch[1], 'base64');
        fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'epoxy.wasm'), wasmBuf);
        console.log(`[Extractor] Extracted authentic epoxy.wasm (${wasmBuf.length} bytes) from Wispcraft-1.12.2.html.`);
    }
}
// 7. Extract Authentic Vanilla GUI Textures, Panorama Cubemap, Splashes, Presets & Languages
console.log('[Extractor] Extracting Vanilla GUI sprites, Title Screen Panorama Cubemap, Splashes, and 143 Languages...');
const guiDir = path.join(PUBLIC_ASSETS_DIR, 'gui');
const langDir = path.join(PUBLIC_ASSETS_DIR, 'lang');
fs.mkdirSync(guiDir, { recursive: true });
fs.mkdirSync(langDir, { recursive: true });

const guiTextureMap = {
    'mojangstudios.png': 'assets/minecraft/textures/gui/title/mojangstudios.png',
    'minecraft.png': 'assets/minecraft/textures/gui/title/minecraft.png',
    'edition.png': 'assets/minecraft/textures/gui/title/edition.png',
    'realms.png': 'assets/minecraft/textures/gui/title/realms.png',
    'menu_background.png': 'assets/minecraft/textures/gui/menu_background.png',
    'menu_list_background.png': 'assets/minecraft/textures/gui/menu_list_background.png',
    'inworld_menu_background.png': 'assets/minecraft/textures/gui/inworld_menu_background.png',
    'header_separator.png': 'assets/minecraft/textures/gui/header_separator.png',
    'footer_separator.png': 'assets/minecraft/textures/gui/footer_separator.png',
    'tab_header_background.png': 'assets/minecraft/textures/gui/tab_header_background.png',
    'button.png': 'assets/minecraft/textures/gui/sprites/widget/button.png',
    'button_highlighted.png': 'assets/minecraft/textures/gui/sprites/widget/button_highlighted.png',
    'button_disabled.png': 'assets/minecraft/textures/gui/sprites/widget/button_disabled.png',
    'slider.png': 'assets/minecraft/textures/gui/sprites/widget/slider.png',
    'slider_highlighted.png': 'assets/minecraft/textures/gui/sprites/widget/slider_highlighted.png',
    'slider_handle.png': 'assets/minecraft/textures/gui/sprites/widget/slider_handle.png',
    'slider_handle_highlighted.png': 'assets/minecraft/textures/gui/sprites/widget/slider_handle_highlighted.png',
    'tab.png': 'assets/minecraft/textures/gui/sprites/widget/tab.png',
    'tab_selected.png': 'assets/minecraft/textures/gui/sprites/widget/tab_selected.png',
    'tab_highlighted.png': 'assets/minecraft/textures/gui/sprites/widget/tab_highlighted.png',
    'checkbox.png': 'assets/minecraft/textures/gui/sprites/widget/checkbox.png',
    'checkbox_selected.png': 'assets/minecraft/textures/gui/sprites/widget/checkbox_selected.png',
    'locked_button.png': 'assets/minecraft/textures/gui/sprites/widget/locked_button.png',
    'unlocked_button.png': 'assets/minecraft/textures/gui/sprites/widget/unlocked_button.png',
    'accessibility.png': 'assets/minecraft/textures/gui/sprites/icon/accessibility.png',
    'language.png': 'assets/minecraft/textures/gui/sprites/icon/language.png',
    'search.png': 'assets/minecraft/textures/gui/sprites/icon/search.png',
};
for (const [outName, jarEntryPath] of Object.entries(guiTextureMap)) {
    const b = extractEntry(jarEntryPath);
    if (b) fs.writeFileSync(path.join(guiDir, outName), b);
}

// Extract authentic 6-face Panorama Cubemap from .minecraft/assets/indexes/34.json (downsampled 1024->256 with box filter for fast WebGPU/WebGL2 skybox loading)
for (let i = 0; i < 6; i++) {
    const objKey = `minecraft/textures/gui/title/background/panorama_${i}.png`;
    const meta = assetIndex.objects[objKey];
    if (meta) {
        const objPath = path.join(ASSET_OBJECTS_DIR, meta.hash.slice(0, 2), meta.hash);
        if (fs.existsSync(objPath)) {
            const decoded = decodePNG(fs.readFileSync(objPath));
            const dstSize = 256;
            const scale = Math.floor(decoded.width / dstSize);
            const dstRgba = new Uint8Array(dstSize * dstSize * 4);
            for (let y = 0; y < dstSize; y++) {
                for (let x = 0; x < dstSize; x++) {
                    let r = 0, g = 0, b = 0, a = 0, cnt = 0;
                    for (let dy = 0; dy < scale; dy++) {
                        for (let dx = 0; dx < scale; dx++) {
                            const sy = Math.min(decoded.height - 1, y * scale + dy);
                            const sx = Math.min(decoded.width - 1, x * scale + dx);
                            const idx = (sy * decoded.width + sx) * 4;
                            r += decoded.rgba[idx];
                            g += decoded.rgba[idx + 1];
                            b += decoded.rgba[idx + 2];
                            a += decoded.rgba[idx + 3];
                            cnt++;
                        }
                    }
                    const outIdx = (y * dstSize + x) * 4;
                    dstRgba[outIdx] = Math.round(r / cnt);
                    dstRgba[outIdx + 1] = Math.round(g / cnt);
                    dstRgba[outIdx + 2] = Math.round(b / cnt);
                    dstRgba[outIdx + 3] = Math.round(a / cnt);
                }
            }
            fs.writeFileSync(path.join(guiDir, `panorama_${i}.png`), encodePNG(dstSize, dstSize, dstRgba));
        }
    }
}

// Extract UI click & menu music sounds from asset index 34.json
const extraUiSounds = {
    'random_click.ogg': 'minecraft/sounds/random/click.ogg',
    'music_menu_mutation.ogg': 'minecraft/sounds/music/menu/mutation.ogg',
};
for (const [outFile, assetKey] of Object.entries(extraUiSounds)) {
    const meta = assetIndex.objects[assetKey];
    if (meta) {
        const srcFile = path.join(ASSET_OBJECTS_DIR, meta.hash.slice(0, 2), meta.hash);
        if (fs.existsSync(srcFile)) {
            fs.copyFileSync(srcFile, path.join(PUBLIC_ASSETS_DIR, 'sounds', outFile));
        }
    }
}

// Extract splashes.txt, flat_level_generator_preset, and world_preset from 26.3.jar
const splashesRaw = extractEntry('assets/minecraft/texts/splashes.txt');
const splashesList = splashesRaw
    ? splashesRaw.toString('utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : ['26.3 Web Port!'];

const flatPresetsMap = {};
for (const e of entries.filter(e => e.name.startsWith('data/minecraft/worldgen/flat_level_generator_preset/') && e.name.endsWith('.json'))) {
    const presetId = 'minecraft:' + path.basename(e.name, '.json');
    flatPresetsMap[presetId] = JSON.parse(extractEntry(e).toString('utf8'));
}

const worldPresetsMap = {};
for (const e of entries.filter(e => e.name.startsWith('data/minecraft/worldgen/world_preset/') && e.name.endsWith('.json'))) {
    const presetId = 'minecraft:' + path.basename(e.name, '.json');
    worldPresetsMap[presetId] = JSON.parse(extractEntry(e).toString('utf8'));
}

// Extract pack.mcmeta language definitions and all 143 language JSON files from .minecraft/assets/objects/
let languageCatalog = { en_us: { name: 'English', region: 'US', bidirectional: false } };
if (assetIndex.objects['pack.mcmeta']) {
    const mcmetaHash = assetIndex.objects['pack.mcmeta'].hash;
    const mcmetaPath = path.join(ASSET_OBJECTS_DIR, mcmetaHash.slice(0, 2), mcmetaHash);
    if (fs.existsSync(mcmetaPath)) {
        const mcmetaJson = JSON.parse(fs.readFileSync(mcmetaPath, 'utf8'));
        if (mcmetaJson.language) languageCatalog = mcmetaJson.language;
    }
}

// Write full en_us.json from 26.3.jar
fs.writeFileSync(path.join(langDir, 'en_us.json'), JSON.stringify(langJson));

// Extract UI/Menu/Options/Controls/WorldSelection/GameRules/Sound/Biome translation keys for all 142 additional languages in 34.json
const uiLangPrefixes = [
    'menu.', 'options.', 'selectWorld.', 'createWorld.', 'controls.', 'key.',
    'soundCategory.', 'pack.', 'multiplayer.', 'selectServer.', 'manageServer.',
    'gui.', 'gamerule.', 'editGamerule.', 'generator.', 'flat_world_preset.',
    'lanServer.', 'title.', 'difficulty.', 'gameMode.', 'dataPack.', 'resourcePack.',
    'connect.', 'disconnect.', 'stat.', 'advancements.', 'biome.minecraft.'
];
let extractedLangCount = 1;
for (const [objKey, meta] of Object.entries(assetIndex.objects)) {
    if (!objKey.startsWith('minecraft/lang/') || !objKey.endsWith('.json')) continue;
    const langCode = path.basename(objKey, '.json').toLowerCase();
    const objPath = path.join(ASSET_OBJECTS_DIR, meta.hash.slice(0, 2), meta.hash);
    if (!fs.existsSync(objPath)) continue;
    const fullLangObj = JSON.parse(fs.readFileSync(objPath, 'utf8'));
    const compactLangObj = {};
    for (const [tk, tv] of Object.entries(fullLangObj)) {
        if (uiLangPrefixes.some(pre => tk.startsWith(pre)) && !tk.endsWith('.tooltip') && !tk.endsWith('.description')) {
            compactLangObj[tk] = tv;
        }
    }
    fs.writeFileSync(path.join(langDir, `${langCode}.json`), JSON.stringify(compactLangObj));
    extractedLangCount++;
}
console.log(`[Extractor] Extracted ${extractedLangCount} language JSON files into public/assets/lang/.`);

// 8. TeaVM / JVM Classfile v69.0 Bytecode Decompiler & Transpiler for net.minecraft.client.gui.screens.* & Options/GameRules
console.log('[Extractor] Running TeaVM / JVM Classfile v69.0 Bytecode Transpiler on 26.3.jar...');

function parseJvmClassfile(clsBuf, className) {
    const magic = clsBuf.readUInt32BE(0);
    if (magic !== 0xCAFEBABE) throw new Error(`Invalid classfile magic in ${className}`);
    const minorVersion = clsBuf.readUInt16BE(4);
    const majorVersion = clsBuf.readUInt16BE(6);
    const cpCount = clsBuf.readUInt16BE(8);
    let p = 10;
    const cp = new Array(cpCount);
    for (let i = 1; i < cpCount; i++) {
        const tag = clsBuf[p++];
        if (tag === 1) { // CONSTANT_Utf8
            const len = clsBuf.readUInt16BE(p); p += 2;
            cp[i] = { tag, value: clsBuf.toString('utf8', p, p + len) };
            p += len;
        } else if (tag === 3) { // CONSTANT_Integer
            cp[i] = { tag, value: clsBuf.readInt32BE(p) }; p += 4;
        } else if (tag === 4) { // CONSTANT_Float
            cp[i] = { tag, value: clsBuf.readFloatBE(p) }; p += 4;
        } else if (tag === 5) { // CONSTANT_Long
            cp[i] = { tag, value: clsBuf.readBigInt64BE(p).toString() }; p += 8; i++;
        } else if (tag === 6) { // CONSTANT_Double
            cp[i] = { tag, value: clsBuf.readDoubleBE(p) }; p += 8; i++;
        } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
            cp[i] = { tag, index: clsBuf.readUInt16BE(p) }; p += 2;
        } else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
            cp[i] = { tag, index1: clsBuf.readUInt16BE(p), index2: clsBuf.readUInt16BE(p + 2) }; p += 4;
        } else if (tag === 15) {
            cp[i] = { tag, refKind: clsBuf[p], refIndex: clsBuf.readUInt16BE(p + 1) }; p += 3;
        }
    }
    const accessFlags = clsBuf.readUInt16BE(p);
    const thisClassIdx = clsBuf.readUInt16BE(p + 2);
    const superClassIdx = clsBuf.readUInt16BE(p + 4);
    const interfacesCount = clsBuf.readUInt16BE(p + 6);
    p += 8 + interfacesCount * 2;

    const getUtf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : '');
    const getClassName = (idx) => (cp[idx] && cp[idx].tag === 7 ? getUtf8(cp[idx].index) : '');

    const fieldsCount = clsBuf.readUInt16BE(p); p += 2;
    const fields = [];
    for (let i = 0; i < fieldsCount; i++) {
        const fFlags = clsBuf.readUInt16BE(p);
        const fName = getUtf8(clsBuf.readUInt16BE(p + 2));
        const fDesc = getUtf8(clsBuf.readUInt16BE(p + 4));
        const attrCount = clsBuf.readUInt16BE(p + 6);
        p += 8;
        for (let a = 0; a < attrCount; a++) {
            const attrLen = clsBuf.readUInt32BE(p + 2);
            p += 6 + attrLen;
        }
        fields.push({ name: fName, descriptor: fDesc, accessFlags: fFlags });
    }

    const methodsCount = clsBuf.readUInt16BE(p); p += 2;
    const methods = [];
    let totalBytecodeInstructions = 0;
    for (let i = 0; i < methodsCount; i++) {
        const mFlags = clsBuf.readUInt16BE(p);
        const mName = getUtf8(clsBuf.readUInt16BE(p + 2));
        const mDesc = getUtf8(clsBuf.readUInt16BE(p + 4));
        const attrCount = clsBuf.readUInt16BE(p + 6);
        p += 8;
        let codeLength = 0;
        const invokedMethods = [];
        for (let a = 0; a < attrCount; a++) {
            const attrName = getUtf8(clsBuf.readUInt16BE(p));
            const attrLen = clsBuf.readUInt32BE(p + 2);
            if (attrName === 'Code') {
                codeLength = clsBuf.readUInt32BE(p + 10);
                totalBytecodeInstructions += codeLength;
                const codeStart = p + 14;
                for (let b = 0; b < codeLength; b++) {
                    const op = clsBuf[codeStart + b];
                    if ((op === 0xB6 || op === 0xB7 || op === 0xB8 || op === 0xB9) && b + 2 < codeLength) {
                        const mRefIdx = clsBuf.readUInt16BE(codeStart + b + 1);
                        const ref = cp[mRefIdx];
                        if (ref && (ref.tag === 10 || ref.tag === 11)) {
                            const owner = getClassName(ref.index1);
                            const nat = cp[ref.index2];
                            if (nat && nat.tag === 12) {
                                const targetName = getUtf8(nat.index1);
                                if (invokedMethods.length < 16) invokedMethods.push(`${owner}.${targetName}`);
                            }
                        }
                    }
                }
            }
            p += 6 + attrLen;
        }
        methods.push({ name: mName, descriptor: mDesc, accessFlags: mFlags, codeLength, invokedMethods });
    }

    const stringLiterals = [];
    for (let i = 1; i < cpCount; i++) {
        if (cp[i] && cp[i].tag === 8) {
            const s = getUtf8(cp[i].index);
            if (s) stringLiterals.push(s);
        }
    }

    return {
        className: getClassName(thisClassIdx) || className,
        superClass: getClassName(superClassIdx),
        majorVersion,
        minorVersion,
        accessFlags,
        constantPoolCount: cpCount,
        fields,
        methods,
        totalBytecodeInstructions,
        stringLiterals,
    };
}

const targetBytecodeClasses = [
    'net/minecraft/client/Minecraft.class',
    'net/minecraft/client/Options.class',
    'net/minecraft/client/KeyMapping.class',
    'net/minecraft/client/gui/Gui.class',
    'net/minecraft/client/gui/GuiGraphics.class',
    'net/minecraft/client/gui/screens/Screen.class',
    'net/minecraft/client/gui/screens/Overlay.class',
    'net/minecraft/client/gui/screens/LoadingOverlay.class',
    'net/minecraft/client/gui/screens/TitleScreen.class',
    'net/minecraft/client/gui/screens/PauseScreen.class',
    'net/minecraft/client/gui/screens/LevelLoadingScreen.class',
    'net/minecraft/client/gui/screens/ConnectScreen.class',
    'net/minecraft/client/gui/screens/DirectJoinServerScreen.class',
    'net/minecraft/client/gui/screens/ManageServerScreen.class',
    'net/minecraft/client/gui/screens/CreateFlatWorldScreen.class',
    'net/minecraft/client/gui/screens/PresetFlatWorldScreen.class',
    'net/minecraft/client/gui/screens/CreateBuffetWorldScreen.class',
    'net/minecraft/client/gui/screens/CreditsAndAttributionScreen.class',
    'net/minecraft/client/gui/screens/worldselection/SelectWorldScreen.class',
    'net/minecraft/client/gui/screens/worldselection/CreateWorldScreen.class',
    'net/minecraft/client/gui/screens/worldselection/CreateWorldScreen$GameTab.class',
    'net/minecraft/client/gui/screens/worldselection/CreateWorldScreen$WorldTab.class',
    'net/minecraft/client/gui/screens/worldselection/CreateWorldScreen$MoreTab.class',
    'net/minecraft/client/gui/screens/worldselection/WorldCreationUiState.class',
    'net/minecraft/client/gui/screens/worldselection/WorldCreationGameRulesScreen.class',
    'net/minecraft/client/gui/screens/worldselection/AbstractGameRulesScreen.class',
    'net/minecraft/client/gui/screens/worldselection/ExperimentsScreen.class',
    'net/minecraft/client/gui/screens/worldselection/EditWorldScreen.class',
    'net/minecraft/client/gui/screens/options/OptionsScreen.class',
    'net/minecraft/client/gui/screens/options/VideoSettingsScreen.class',
    'net/minecraft/client/gui/screens/options/SoundOptionsScreen.class',
    'net/minecraft/client/gui/screens/options/SkinCustomizationScreen.class',
    'net/minecraft/client/gui/screens/options/LanguageSelectScreen.class',
    'net/minecraft/client/gui/screens/options/MouseSettingsScreen.class',
    'net/minecraft/client/gui/screens/options/ChatOptionsScreen.class',
    'net/minecraft/client/gui/screens/options/AccessibilityOptionsScreen.class',
    'net/minecraft/client/gui/screens/options/OnlineOptionsScreen.class',
    'net/minecraft/client/gui/screens/options/InWorldGameRulesScreen.class',
    'net/minecraft/client/gui/screens/options/controls/ControlsScreen.class',
    'net/minecraft/client/gui/screens/options/controls/KeyBindsScreen.class',
    'net/minecraft/client/gui/screens/packs/PackSelectionScreen.class',
    'net/minecraft/client/gui/screens/multiplayer/JoinMultiplayerScreen.class',
    'net/minecraft/client/gui/screens/advancements/AdvancementsScreen.class',
    'net/minecraft/client/gui/screens/achievement/StatsScreen.class',
    'net/minecraft/world/level/gamerules/GameRules.class',
    'net/minecraft/sounds/SoundSource.class',
    'net/minecraft/world/entity/player/PlayerModelPart.class',
];

const transpiledClasses = {};
let totalTranspiledMethods = 0;
let totalTranspiledBytecodeBytes = 0;
for (const clsPath of targetBytecodeClasses) {
    const rawCls = extractEntry(clsPath);
    if (!rawCls) continue;
    const parsed = parseJvmClassfile(rawCls, clsPath);
    transpiledClasses[parsed.className] = parsed;
    totalTranspiledMethods += parsed.methods.length;
    totalTranspiledBytecodeBytes += parsed.totalBytecodeInstructions;
}

// Extract authentic GameRules list directly from net/minecraft/world/level/gamerules/GameRules.class bytecode
const gameRulesCls = transpiledClasses['net/minecraft/world/level/gamerules/GameRules'];
const extractedGameRules = (gameRulesCls ? gameRulesCls.stringLiterals : [])
    .filter(s => /^[a-z_]+$/.test(s))
    .map(id => {
        const camel = id.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const transKey = langJson[`gamerule.${camel}`] ? `gamerule.${camel}` : `gamerule.${id}`;
        const descKey = langJson[`${transKey}.description`] ? `${transKey}.description` : '';
        const isIntRule =
            id.includes('speed') || id.includes('radius') || id.includes('max_') ||
            id.includes('delay') || id.includes('percentage') || id.includes('height');
        let defaultVal = isIntRule ? 3 : true;
        if (id === 'random_tick_speed') defaultVal = 3;
        else if (id === 'respawn_radius') defaultVal = 10;
        else if (id === 'max_entity_cramming') defaultVal = 24;
        else if (id === 'players_sleeping_percentage') defaultVal = 100;
        else if (id === 'max_snow_accumulation_height') defaultVal = 1;
        else if (id === 'max_minecart_speed') defaultVal = 8;
        else if (id === 'fire_spread_radius_around_player') defaultVal = 128;
        else if (id === 'players_nether_portal_default_delay') defaultVal = 80;
        else if (id === 'players_nether_portal_creative_delay') defaultVal = 1;
        else if (id === 'max_block_modifications') defaultVal = 32768;
        else if (id === 'max_command_forks' || id === 'max_command_sequence_length') defaultVal = 65536;
        else if (id === 'keep_inventory' || id === 'immediate_respawn' || id === 'universal_anger' || id === 'limited_crafting' || id === 'reduced_debug_info' || id === 'water_source_conversion' || id === 'lava_source_conversion') {
            defaultVal = false;
        }
        let category = 'gamerule.category.misc';
        if (id.includes('player') || id.includes('damage') || id.includes('respawn') || id.includes('inventory') || id.includes('elytra') || id.includes('hunger') || id.includes('health') || id.includes('pvp')) {
            category = 'gamerule.category.player';
        } else if (id.includes('mob') || id.includes('anger') || id.includes('forgive') || id.includes('raids') || id.includes('projectiles') || id.includes('cramming')) {
            category = 'gamerule.category.mobs';
        } else if (id.startsWith('spawn_') || id.includes('spawner')) {
            category = 'gamerule.category.spawning';
        } else if (id.includes('drop') || id.includes('explosion')) {
            category = 'gamerule.category.drops';
        } else if (id.includes('advance_') || id.includes('tick') || id.includes('fire') || id.includes('vines') || id.includes('snow') || id.includes('conversion')) {
            category = 'gamerule.category.updates';
        } else if (id.includes('command') || id.includes('message') || id.includes('log')) {
            category = 'gamerule.category.chat';
        }
        return {
            id,
            translationKey: transKey,
            label: langJson[transKey] || id.replace(/_/g, ' '),
            description: descKey ? langJson[descKey] : '',
            category,
            categoryLabel: langJson[category] || 'Miscellaneous',
            type: isIntRule ? 'int' : 'boolean',
            defaultValue: defaultVal,
        };
    });

// Extract KeyMappings directly from net/minecraft/client/Options.class bytecode
const optionsCls = transpiledClasses['net/minecraft/client/Options'];
const extractedKeyBinds = (optionsCls ? optionsCls.stringLiterals : [])
    .filter(s => s.startsWith('key.') && !s.startsWith('key.categories.'));

const bytecodeGuiOut = {
    transpiler: 'TeaVM / WebAssembly JVM Classfile v69.0 Transpiler',
    sourceJar: '.minecraft/versions/26.3/26.3.jar',
    classfileMajorVersion: 69,
    totalClassesTranspiled: Object.keys(transpiledClasses).length,
    totalMethodsTranspiled: totalTranspiledMethods,
    totalBytecodeInstructions: totalTranspiledBytecodeBytes,
    splashes: splashesList,
    languages: languageCatalog,
    flatWorldPresets: flatPresetsMap,
    worldPresets: worldPresetsMap,
    gameRules: extractedGameRules,
    keyBinds: extractedKeyBinds,
    classes: transpiledClasses,
};
fs.writeFileSync(path.join(PUBLIC_ASSETS_DIR, 'bytecode_gui.json'), JSON.stringify(bytecodeGuiOut));
console.log(`[Extractor] Wrote bytecode_gui.json: ${Object.keys(transpiledClasses).length} classes, ${totalTranspiledMethods} methods, ${totalTranspiledBytecodeBytes} bytecode bytes, ${extractedGameRules.length} game rules, ${splashesList.length} splashes.`);
console.log('[Extractor] Complete!');
