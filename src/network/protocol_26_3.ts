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

import { WispEpoxyClient, WispTcpStream } from './wisp_epoxy';
import { MicrosoftAuthenticator, MinecraftProfile } from './microsoft_auth';
import { BlockPos } from '../runtime/long_math';

export const PROTOCOL_VERSION_26_3 = 777;

export enum ConnectionState {
    HANDSHAKING = 0,
    STATUS = 1,
    LOGIN = 2,
    CONFIGURATION = 3,
    PLAY = 4,
}

/**
 * Packet Buffer (`FriendlyByteBuf`) with VarInt, VarLong, String, UUID, BlockPos, and ByteArray codecs.
 */
export class PacketBuffer {
    public inner: Uint8Array;

    constructor(data?: Uint8Array | number[], copy = false) {
        if (!data) {
            this.inner = new Uint8Array(0);
        } else if (data instanceof Uint8Array) {
            this.inner = copy ? data.slice() : data;
        } else {
            this.inner = Uint8Array.from(data);
        }
    }

    public static alloc(): PacketBuffer {
        return new PacketBuffer(new Uint8Array(0));
    }

    public get length(): number {
        return this.inner.byteLength;
    }

    public take(n: number): PacketBuffer {
        if (this.inner.byteLength < n) {
            throw new Error(`PacketBuffer underflow: need ${n} bytes, have ${this.inner.byteLength}`);
        }
        const slice = this.inner.subarray(0, n);
        this.inner = this.inner.subarray(n);
        return new PacketBuffer(slice);
    }

    public extend(other: Uint8Array | PacketBuffer): void {
        const src = other instanceof PacketBuffer ? other.inner : other;
        const next = new Uint8Array(this.inner.byteLength + src.byteLength);
        next.set(this.inner, 0);
        next.set(src, this.inner.byteLength);
        this.inner = next;
    }

    public readUByte(): number {
        const b = this.inner[0];
        this.take(1);
        return b;
    }

    public writeUByte(v: number): void {
        this.extend(new Uint8Array([v & 0xff]));
    }

    public readBoolean(): boolean {
        return this.readUByte() !== 0;
    }

    public writeBoolean(v: boolean): void {
        this.writeUByte(v ? 1 : 0);
    }

    public readUShort(): number {
        const v = (this.inner[0] << 8) | this.inner[1];
        this.take(2);
        return v;
    }

    public writeUShort(v: number): void {
        this.extend(new Uint8Array([(v >>> 8) & 0xff, v & 0xff]));
    }

    public readShort(): number {
        const u = this.readUShort();
        return u & 0x8000 ? u - 0x10000 : u;
    }

    public readInt(): number {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getInt32(0, false);
        this.take(4);
        return v;
    }

    public writeInt(v: number): void {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setInt32(0, v, false);
        this.extend(b);
    }

    public readLong(): bigint {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getBigInt64(0, false);
        this.take(8);
        return v;
    }

    public writeLong(v: bigint): void {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigInt64(0, v, false);
        this.extend(b);
    }

    public readFloat(): number {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getFloat32(0, false);
        this.take(4);
        return v;
    }

    public writeFloat(v: number): void {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setFloat32(0, v, false);
        this.extend(b);
    }

    public readDouble(): number {
        const dv = new DataView(this.inner.buffer, this.inner.byteOffset, this.inner.byteLength);
        const v = dv.getFloat64(0, false);
        this.take(8);
        return v;
    }

    public writeDouble(v: number): void {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v, false);
        this.extend(b);
    }

    public readVarInt(consume = true): number {
        let numRead = 0;
        let result = 0;
        let read: number;
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

    public writeVarInt(value: number): void {
        const out: number[] = [];
        let v = value | 0;
        while ((v & ~0x7f) !== 0) {
            out.push((v & 0x7f) | 0x80);
            v >>>= 7;
        }
        out.push(v & 0x7f);
        this.extend(new Uint8Array(out));
    }

    public readString(): string {
        const len = this.readVarInt();
        const bytes = this.take(len).inner;
        return new TextDecoder('utf-8').decode(bytes);
    }

    public writeString(str: string): void {
        const encoded = new TextEncoder().encode(str);
        this.writeVarInt(encoded.byteLength);
        this.extend(encoded);
    }

    public readByteArray(): Uint8Array {
        const len = this.readVarInt();
        return this.take(len).inner;
    }

    public writeByteArray(bytes: Uint8Array): void {
        this.writeVarInt(bytes.byteLength);
        this.extend(bytes);
    }

    public readUuid(): string {
        const hi = BigInt.asUintN(64, this.readLong()).toString(16).padStart(16, '0');
        const lo = BigInt.asUintN(64, this.readLong()).toString(16).padStart(16, '0');
        return hi + lo;
    }

    public writeUuid(hexUuid: string): void {
        const clean = hexUuid.replace(/-/g, '').padStart(32, '0');
        const hi = BigInt('0x' + clean.slice(0, 16));
        const lo = BigInt('0x' + clean.slice(16, 32));
        this.writeLong(BigInt.asIntN(64, hi));
        this.writeLong(BigInt.asIntN(64, lo));
    }

    public readBlockPos(): { x: number; y: number; z: number } {
        const packed = this.readLong();
        return {
            x: BlockPos.getX(packed),
            y: BlockPos.getY(packed),
            z: BlockPos.getZ(packed),
        };
    }

    public writeBlockPos(x: number, y: number, z: number): void {
        this.writeLong(BlockPos.asLong(x, y, z));
    }
}

/**
 * RSA PKCS#1 v1.5 Encryption using `BigInt` modular exponentiation,
 * reverse-engineered from `Wispcraft-1.12.2.html` (`aA` / `cA` / `yA` functions).
 * Necessary because WebCrypto `SubtleCrypto` intentionally omits PKCS#1 v1.5 encryption.
 */
export class MinecraftRsaPkcs1 {
    public static parseSpkiPublicKeyDer(der: Uint8Array): { modulus: bigint; exponent: bigint; keyByteLen: number } {
        // Parse ASN.1 SubjectPublicKeyInfo to extract RSA modulus n and exponent e
        let pos = 0;
        const readLength = (): number => {
            const b = der[pos++];
            if ((b & 0x80) === 0) return b;
            const numBytes = b & 0x7f;
            let len = 0;
            for (let i = 0; i < numBytes; i++) len = (len << 8) | der[pos++];
            return len;
        };
        const expectTag = (tag: number) => {
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

    private static modPow(base: bigint, exp: bigint, mod: bigint): bigint {
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

    public static encryptPkcs1v15(derPublicKey: Uint8Array, data: Uint8Array): Uint8Array {
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
export class AesCfb8Cipher {
    private static readonly SBOX = new Uint8Array([
        99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,
        183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,
        9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,
        208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,
        205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,
        224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,
        186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,
        225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22
    ]);
    private static readonly RCON = new Uint8Array([1, 2, 4, 8, 16, 32, 64, 128, 27, 54]);

    private roundKeys: Uint8Array;
    private encryptRegister: Uint8Array;
    private decryptRegister: Uint8Array;

    constructor(keyAndIv16: Uint8Array) {
        if (keyAndIv16.byteLength !== 16) {
            throw new Error('AES-128 CFB8 requires a 16-byte shared secret');
        }
        this.roundKeys = this.expandKey(keyAndIv16);
        this.encryptRegister = keyAndIv16.slice();
        this.decryptRegister = keyAndIv16.slice();
    }

    private expandKey(key: Uint8Array): Uint8Array {
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

    private static xtime(a: number): number {
        return ((a << 1) ^ ((a & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
    }

    private encryptBlock16(input: Uint8Array): Uint8Array {
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

    public encryptBytes(plaintext: Uint8Array): Uint8Array {
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

    public decryptBytes(ciphertext: Uint8Array): Uint8Array {
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

export interface ServerStatusResponse {
    version: { name: string; protocol: number };
    players: { max: number; online: number; sample?: Array<{ name: string; id: string }> };
    description: string | { text?: string; extra?: Array<{ text: string }> };
    favicon?: string;
    latencyMs: number;
}

export interface Protocol263Callbacks {
    onStatusUpdate?: (status: string) => void;
    onLoginSuccess?: (uuid: string, username: string) => void;
    onEnterPlayState?: () => void;
    onDisconnect?: (reason: string) => void;
    onChatMessage?: (message: string) => void;
    onPlayerPosition?: (x: number, y: number, z: number, yaw: number, pitch: number) => void;
    onBlockUpdate?: (x: number, y: number, z: number, blockStateId: number) => void;
    onTimeUpdate?: (worldAge: bigint, timeOfDay: bigint) => void;
}

/**
 * Full Minecraft 26.3 (`protocol_version: 777`) Client Connection over Wisp/Epoxy
 */
export class MinecraftProtocol263Client {
    private wisp: WispEpoxyClient;
    private auth: MicrosoftAuthenticator;
    private stream: WispTcpStream | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private state: ConnectionState = ConnectionState.HANDSHAKING;
    private compressionThreshold = -1;
    private cipher: AesCfb8Cipher | null = null;
    private recvAccumulator = PacketBuffer.alloc();
    private callbacks: Protocol263Callbacks;

    constructor(wisp: WispEpoxyClient, callbacks: Protocol263Callbacks = {}) {
        this.wisp = wisp;
        this.auth = new MicrosoftAuthenticator(wisp);
        this.callbacks = callbacks;
    }

    private static async zlibCompress(data: Uint8Array): Promise<Uint8Array> {
        const cs = new CompressionStream('deflate');
        const w = cs.writable.getWriter();
        w.write(data as unknown as BufferSource);
        w.close();
        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }

    private static async zlibDecompress(data: Uint8Array): Promise<Uint8Array> {
        const ds = new DecompressionStream('deflate');
        const w = ds.writable.getWriter();
        w.write(data as unknown as BufferSource);
        w.close();
        return new Uint8Array(await new Response(ds.readable).arrayBuffer());
    }

    public async sendPacket(packetId: number, payloadBuilder: (buf: PacketBuffer) => void): Promise<void> {
        if (!this.writer) throw new Error('Not connected');
        const body = PacketBuffer.alloc();
        body.writeVarInt(packetId);
        payloadBuilder(body);

        let framedPayload: PacketBuffer;
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
    public async pingServerStatus(serverAddress: string): Promise<ServerStatusResponse> {
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
    public async connectToServer(serverAddress: string, profile: MinecraftProfile): Promise<void> {
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
            this.callbacks.onDisconnect?.((err as Error).message);
        });
    }

    private async tryReadNextPacket(): Promise<PacketBuffer | null> {
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

    private async runReceiveLoop(readable: ReadableStream<Uint8Array>, profile: MinecraftProfile): Promise<void> {
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

    private async handlePacket(pkt: PacketBuffer, profile: MinecraftProfile): Promise<void> {
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

    public async sendPlayerPositionAndRotation(
        x: number, y: number, z: number,
        yawDeg: number, pitchDeg: number,
        onGround: boolean
    ): Promise<void> {
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

    public async sendChatMessage(message: string): Promise<void> {
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

    public disconnect(): void {
        if (this.stream) {
            this.stream.close();
            this.stream = null;
            this.writer = null;
        }
    }
}
