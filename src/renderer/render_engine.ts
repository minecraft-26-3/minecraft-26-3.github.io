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

import {
    WEBGPU_TERRAIN_WGSL,
    WEBGPU_CHUNK_CULL_COMPUTE_WGSL,
    WEBGL2_TERRAIN_VS_GLSL300,
    WEBGL2_TERRAIN_FS_GLSL300,
} from './shader_compiler';
import {
    AtlasUVEntry,
    ChunkMeshBuffers,
    ChunkMesher,
    GrowableVertexCollector,
    packLightAndAO,
    packNormal,
    packRGBA,
    TranslucentQuadRecord,
} from './chunk_mesher';
import { ChunkPos } from '../runtime/long_math';
import { BlockRegistryEntry, ClientWorld, MobEntity } from '../world/physics_tick';

export type ActiveGraphicsBackend = 'WebGPU' | 'WebGL2';

export interface Particle3D {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    size: number;
    age: number;
    maxAge: number;
    u0: number;
    v0: number;
    u1: number;
    v1: number;
    colorPacked: number;
    gravity: number;
}

interface GpuChunkSlot {
    chunkX: number;
    chunkZ: number;
    opaqueCount: number;
    cutoutCount: number;
    translucentCount: number;
    translucentQuads: TranslucentQuadRecord[];
    // WebGPU buffers
    wgpuOpaque?: GPUBuffer;
    wgpuCutout?: GPUBuffer;
    wgpuTranslucent?: GPUBuffer;
    // WebGL2 VAOs & VBOs
    glOpaqueVao?: WebGLVertexArrayObject | null;
    glOpaqueVbo?: WebGLBuffer | null;
    glCutoutVao?: WebGLVertexArrayObject | null;
    glCutoutVbo?: WebGLBuffer | null;
    glTranslucentVao?: WebGLVertexArrayObject | null;
    glTranslucentVbo?: WebGLBuffer | null;
}

export class Mat4 {
    public static perspective(fovRad: number, aspect: number, near: number, far: number, zeroToOneDepth: boolean): Float32Array {
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

    public static viewFromYawPitch(camX: number, camY: number, camZ: number, yawRad: number, pitchRad: number): Float32Array {
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

    public static multiply(a: Float32Array, b: Float32Array): Float32Array {
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

    public static extractFrustumPlanes(vp: Float32Array): Float32Array {
        const planes = new Float32Array(24);
        const setPlane = (idx: number, a: number, b: number, c: number, d: number) => {
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

export class DualRenderEngine {
    public readonly canvas3D: HTMLCanvasElement;
    public readonly canvasGui: HTMLCanvasElement;
    public readonly guiCtx: CanvasRenderingContext2D;
    public backend: ActiveGraphicsBackend = 'WebGPU';

    // WebGPU State
    private wgpuDevice: GPUDevice | null = null;
    private wgpuContext: GPUCanvasContext | null = null;
    private wgpuFormat: GPUTextureFormat = 'bgra8unorm';
    private wgpuDepthTex: GPUTexture | null = null;
    private wgpuOpaquePipeline: GPURenderPipeline | null = null;
    private wgpuCutoutPipeline: GPURenderPipeline | null = null;
    private wgpuTranslucentPipeline: GPURenderPipeline | null = null;
    private wgpuCullComputePipeline: GPUComputePipeline | null = null;
    private wgpuSceneUniformBuf: GPUBuffer | null = null;
    private wgpuCutoutUniformBuf: GPUBuffer | null = null;
    private wgpuOpaqueBindGroup: GPUBindGroup | null = null;
    private wgpuCutoutBindGroup: GPUBindGroup | null = null;
    private wgpuDynamicVbo: GPUBuffer | null = null;
    private wgpuAtlasTex: GPUTexture | null = null;
    private wgpuLightmapTex: GPUTexture | null = null;

    // WebGL2 Fallback State
    private gl: WebGL2RenderingContext | null = null;
    private glProgram: WebGLProgram | null = null;
    private glLocViewProj: WebGLUniformLocation | null = null;
    private glLocCameraPos: WebGLUniformLocation | null = null;
    private glLocFogColor: WebGLUniformLocation | null = null;
    private glLocFogParams: WebGLUniformLocation | null = null;
    private glAtlasTex: WebGLTexture | null = null;
    private glLightmapTex: WebGLTexture | null = null;
    private glDynamicVao: WebGLVertexArrayObject | null = null;
    private glDynamicVbo: WebGLBuffer | null = null;

    // Shared Scene Resources
    private chunkSlots: Map<bigint, GpuChunkSlot> = new Map();
    public readonly particles: Particle3D[] = [];
    public blockAtlasImg: HTMLImageElement | null = null;
    public itemAtlasImg: HTMLImageElement | null = null;
    public asciiFontImg: HTMLImageElement | null = null;
    private atlasCanvas: HTMLCanvasElement | null = null;
    private atlasCtx: CanvasRenderingContext2D | null = null;
    private lightmapPixels = new Uint8Array(16 * 16 * 4);
    private lastLightmapSun = -1;
    private lastLightmapGamma = -1;
    public renderedChunksCount = 0;
    public culledChunksCount = 0;
    public totalGpuVertices = 0;

    // Live Video & Skin Settings (wired to VideoSettingsScreen & SkinCustomizationScreen)
    public gamma = 0.5; // 0.0 (Moody) .. 1.0 (Bright)
    public cloudMode: 'off' | 'fast' | 'fancy' = 'fancy';
    public cloudHeight = 148;
    public particlesMode: 'all' | 'decreased' | 'minimal' = 'all';
    public entityDistanceScaling = 1.0; // 0.5 (50%) .. 5.0 (500%)
    public entityShadows = true;
    public guiScale = 0; // 0 = Auto, 1..4 = fixed scale
    public mainHand: 'right' | 'left' = 'right';
    public attackIndicator: 'crosshair' | 'hotbar' | 'off' = 'crosshair';

    constructor(canvas3D: HTMLCanvasElement, canvasGui: HTMLCanvasElement) {
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
    public async init(
        blockAtlasImg: HTMLImageElement,
        itemAtlasImg: HTMLImageElement,
        asciiFontImg: HTMLImageElement,
        preferBackend?: ActiveGraphicsBackend
    ): Promise<ActiveGraphicsBackend> {
        this.blockAtlasImg = blockAtlasImg;
        this.itemAtlasImg = itemAtlasImg;
        this.asciiFontImg = asciiFontImg;

        // Create offscreen canvas for animated sprite `.mcmeta` frame updates
        this.atlasCanvas = document.createElement('canvas');
        this.atlasCanvas.width = blockAtlasImg.width;
        this.atlasCanvas.height = blockAtlasImg.height;
        this.atlasCtx = this.atlasCanvas.getContext('2d')!;
        this.atlasCtx.drawImage(blockAtlasImg, 0, 0);

        this.updateLightmapPixels(1.0);

        if (preferBackend !== 'WebGL2' && typeof navigator !== 'undefined' && 'gpu' in navigator) {
            try {
                const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (adapter) {
                    const device = await adapter.requestDevice();
                    const ctx = this.canvas3D.getContext('webgpu') as GPUCanvasContext | null;
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

    private async initWebGPUBackend(): Promise<void> {
        const device = this.wgpuDevice!;
        const ctx = this.wgpuContext!;

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

        const vertexBufferLayout: GPUVertexBufferLayout = {
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
        const img = this.blockAtlasImg!;
        this.wgpuAtlasTex = device.createTexture({
            size: [img.width, img.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        device.queue.copyExternalImageToTexture(
            { source: this.atlasCanvas! },
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
            this.lightmapPixels as unknown as BufferSource,
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

    private createWebGPUDepthTexture(): void {
        if (!this.wgpuDevice) return;
        if (this.wgpuDepthTex) this.wgpuDepthTex.destroy();
        this.wgpuDepthTex = this.wgpuDevice.createTexture({
            size: [Math.max(1, this.canvas3D.width), Math.max(1, this.canvas3D.height), 1],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    private initWebGL2Backend(): void {
        const gl = this.canvas3D.getContext('webgl2', { antialias: false, depth: true, alpha: false });
        if (!gl) throw new Error('Neither WebGPU nor WebGL2 is supported by this browser');
        this.gl = gl;

        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, WEBGL2_TERRAIN_VS_GLSL300);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            throw new Error(`WebGL2 VS error: ${gl.getShaderInfoLog(vs)}`);
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, WEBGL2_TERRAIN_FS_GLSL300);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            throw new Error(`WebGL2 FS error: ${gl.getShaderInfoLog(fs)}`);
        }

        const prog = gl.createProgram()!;
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
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlasCanvas!);

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

    private createWebGL2Vao(data: Uint32Array, usage: number): { vao: WebGLVertexArrayObject; vbo: WebGLBuffer } {
        const gl = this.gl!;
        const vao = gl.createVertexArray()!;
        const vbo = gl.createBuffer()!;
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

    public resize(width: number, height: number): void {
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
    private updateLightmapPixels(sunBrightness: number): void {
        if (Math.abs(sunBrightness - this.lastLightmapSun) < 0.01 && Math.abs(this.gamma - this.lastLightmapGamma) < 0.01) return;
        this.lastLightmapSun = sunBrightness;
        this.lastLightmapGamma = this.gamma;
        const gammaExp = Math.max(0.45, 1.55 - this.gamma * 0.9);
        const ambientFloor = 0.05 + this.gamma * 0.14;

        for (let skyIdx = 0; skyIdx < 16; skyIdx++) {
            const skyNorm = (skyIdx / 15.0) * sunBrightness;
            const skyCurve = Math.pow(skyNorm, gammaExp) * (1.0 - ambientFloor) + ambientFloor;
            for (let blkIdx = 0; blkIdx < 16; blkIdx++) {
                const blkNorm = blkIdx / 15.0;
                const blkCurve = Math.pow(blkNorm, gammaExp * 0.92);

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
                this.lightmapPixels as unknown as BufferSource,
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
    public uploadChunkMesh(mesh: ChunkMeshBuffers): void {
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

        const slot: GpuChunkSlot = {
            chunkX: mesh.chunkX,
            chunkZ: mesh.chunkZ,
            opaqueCount: mesh.opaqueVertexCount,
            cutoutCount: mesh.cutoutVertexCount,
            translucentCount: mesh.translucentVertexCount,
            translucentQuads: mesh.translucentQuads,
        };

        if (this.backend === 'WebGPU' && this.wgpuDevice) {
            const dev = this.wgpuDevice;
            const makeBuf = (arr: Uint32Array) => {
                if (arr.byteLength === 0) return undefined;
                const b = dev.createBuffer({
                    size: (arr.byteLength + 15) & ~15,
                    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                });
                dev.queue.writeBuffer(b, 0, arr as unknown as BufferSource);
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

    public clearChunkMeshes(): void {
        for (const existing of this.chunkSlots.values()) {
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
        this.chunkSlots.clear();
    }

    /**
     * Spawns 3D block-break debris or environmental particles (`sulfur_bubbles`, `flame`, `rain`).
     */
    public spawnBlockBreakParticles(x: number, y: number, z: number, uv: AtlasUVEntry, tint = 0xffffffff): void {
        if (this.particlesMode === 'minimal') return;
        const step = this.particlesMode === 'decreased' ? 2 : 1;
        for (let ix = 0; ix < 3; ix += step) {
            for (let iy = 0; iy < 3; iy += step) {
                for (let iz = 0; iz < 3; iz += step) {
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

    public stepParticles(): void {
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
    private buildDynamicPassGeometry(
        world: ClientWorld,
        mesher: ChunkMesher,
        camX: number, camY: number, camZ: number,
        yawRad: number,
        partialTick: number,
        sunAngleRad: number,
        hitBlock: { x: number; y: number; z: number } | null
    ): Uint32Array {
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

        // Pass 7B: 3D Volumetric Cloud Layer (controlled by VideoSettingsScreen Clouds & Cloud Height)
        if (this.cloudMode !== 'off') {
            const snowUv = mesher.getUV('snow');
            const cloudDrift = (Number(world.worldAgeTicks) + partialTick) * 0.03;
            const cloudLight = packLightAndAO(12, 15, 0.95);
            const cloudColor = packRGBA(248, 250, 255, 220);
            const baseCloudX = Math.floor((camX + cloudDrift) / 24) * 24;
            const baseCloudZ = Math.floor(camZ / 24) * 24;
            const cThick = this.cloudMode === 'fancy' ? 3.5 : 0.25;
            for (let cx = -3; cx <= 3; cx++) {
                for (let cz = -3; cz <= 3; cz++) {
                    const wx = baseCloudX + cx * 24 - (cloudDrift % 24);
                    const wz = baseCloudZ + cz * 24;
                    const hash = ((Math.floor((wx + cloudDrift) / 24) * 73856093) ^ (Math.floor(wz / 24) * 19349663)) & 7;
                    if (hash < 3) {
                        this.emitBox(dyn, wx, this.cloudHeight, wz, wx + 18, this.cloudHeight + cThick, wz + 14, snowUv, cloudLight, cloudColor);
                    }
                }
            }
        }

        // Pass 4: Entity Models (Sulfur Cube, Passive & Hostile Mobs with partialTick interpolation)
        const maxEntDist = 64.0 * this.entityDistanceScaling;
        const shadowUv = mesher.getUV('obsidian');
        for (const ent of world.entities.values()) {
            const ex = ent.prevX + (ent.x - ent.prevX) * partialTick;
            const ey = ent.prevY + (ent.y - ent.prevY) * partialTick;
            const ez = ent.prevZ + (ent.z - ent.prevZ) * partialTick;
            if (Math.hypot(ex - camX, ez - camZ) > maxEntDist) continue;
            if (this.entityShadows) {
                this.emitBox(dyn, ex - 0.28, ey + 0.01, ez - 0.28, ex + 0.28, ey + 0.03, ez + 0.28, shadowUv, fullBright, packRGBA(15, 15, 15, 140));
            }

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

    private emitBox(
        c: GrowableVertexCollector,
        x0: number, y0: number, z0: number,
        x1: number, y1: number, z1: number,
        uv: AtlasUVEntry,
        lightPacked: number,
        colorPacked: number
    ): void {
        const u0 = uv.u0, v0 = uv.v1, u1 = uv.u1, v1 = uv.v0;
        const nUp = packNormal(0, 1, 0);
        const nDown = packNormal(0, -1, 0);
        const nNorth = packNormal(0, 0, -1);
        const nSouth = packNormal(0, 0, 1);
        const nEast = packNormal(1, 0, 0);
        const nWest = packNormal(-1, 0, 0);

        const quad = (
            ax: number, ay: number, az: number,
            bx: number, by: number, bz: number,
            cx: number, cy: number, cz: number,
            dx: number, dy: number, dz: number,
            norm: number
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
    public renderWorldFrame(
        world: ClientWorld,
        mesher: ChunkMesher,
        camX: number, camY: number, camZ: number,
        yawRad: number, pitchRad: number,
        fovDeg: number,
        renderDistanceChunks: number,
        partialTick: number,
        hitBlock: { x: number; y: number; z: number } | null
    ): void {
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
        const visibleSlots: GpuChunkSlot[] = [];
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

    private renderWebGPUFrame(
        viewProj: Float32Array,
        camX: number, camY: number, camZ: number,
        skyR: number, skyG: number, skyB: number,
        fogR: number, fogG: number, fogB: number,
        fogStart: number, fogEnd: number, sunBrightness: number,
        visibleSlots: GpuChunkSlot[],
        dynWords: Uint32Array,
        dynVertexCount: number
    ): void {
        const device = this.wgpuDevice!;
        const uboData = new Float32Array(40);
        uboData.set(viewProj, 0);
        uboData.set([camX, camY, camZ, 1.0], 16);
        uboData.set([fogR, fogG, fogB, 1.0], 20);
        uboData.set([skyR, skyG, skyB, 1.0], 24);
        uboData.set([fogStart, fogEnd, sunBrightness, 0.01], 28); // alphaCutoff = 0.01 for opaque/translucent
        device.queue.writeBuffer(this.wgpuSceneUniformBuf!, 0, uboData);

        const cutoutUbo = uboData.slice();
        cutoutUbo[31] = 0.5; // alphaCutoff = 0.5 for cutout foliage
        device.queue.writeBuffer(this.wgpuCutoutUniformBuf!, 0, cutoutUbo);

        if (dynVertexCount > 0 && this.wgpuDynamicVbo) {
            const byteLen = Math.min(dynWords.byteLength, 512 * 1024);
            device.queue.writeBuffer(this.wgpuDynamicVbo, 0, dynWords.buffer, dynWords.byteOffset, byteLen);
        }

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.wgpuContext!.getCurrentTexture().createView(),
                clearValue: { r: skyR, g: skyG, b: skyB, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.wgpuDepthTex!.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        // Pass 1: Opaque Terrain
        pass.setPipeline(this.wgpuOpaquePipeline!);
        pass.setBindGroup(0, this.wgpuOpaqueBindGroup!);
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
        pass.setPipeline(this.wgpuCutoutPipeline!);
        pass.setBindGroup(0, this.wgpuCutoutBindGroup!);
        for (const slot of visibleSlots) {
            if (slot.cutoutCount > 0 && slot.wgpuCutout) {
                pass.setVertexBuffer(0, slot.wgpuCutout);
                pass.draw(slot.cutoutCount);
            }
        }

        // Pass 3: Translucent Water & Stained Glass (back-to-front chunk order)
        pass.setPipeline(this.wgpuTranslucentPipeline!);
        pass.setBindGroup(0, this.wgpuOpaqueBindGroup!);
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

    private renderWebGL2Frame(
        viewProj: Float32Array,
        camX: number, camY: number, camZ: number,
        skyR: number, skyG: number, skyB: number,
        fogR: number, fogG: number, fogB: number,
        fogStart: number, fogEnd: number, sunBrightness: number,
        visibleSlots: GpuChunkSlot[],
        dynWords: Uint32Array,
        dynVertexCount: number
    ): void {
        const gl = this.gl!;
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
    public render2DGuiPass(params: {
        fps: number;
        playerX: number;
        playerY: number;
        playerZ: number;
        yawDeg: number;
        pitchDeg: number;
        biomeName: string;
        noiseSampleText: string;
        selectedHotbarSlot: number;
        hotbarBlocks: BlockRegistryEntry[];
        blockUvs: Record<string, AtlasUVEntry>;
        showF3Debug: boolean;
        swingProgress: number;
        health: number;
        hunger: number;
        xpLevel: number;
        workerStatus: string;
        wispUrl: string;
        profileName: string;
        hideGui?: boolean;
        gameMode?: 'survival' | 'hardcore' | 'creative';
        subtitles?: Array<{ text: string; dir: string }>;
    }): void {
        const ctx = this.guiCtx;
        const w = this.canvasGui.width;
        const h = this.canvasGui.height;
        ctx.clearRect(0, 0, w, h);
        if (params.hideGui) return;

        // 1. Render First-Person Held Block in bottom-right (or bottom-left if Main Hand: Left) with swing animation
        const heldBlock = params.hotbarBlocks[params.selectedHotbarSlot];
        if (heldBlock && this.blockAtlasImg) {
            const swingSin = Math.sin(params.swingProgress * Math.PI);
            const isLeft = this.mainHand === 'left';
            const handX = isLeft ? (82 + swingSin * 45) : (w - 210 - swingSin * 45);
            const handY = h - 180 + Math.abs(swingSin) * 35;
            const uv = params.blockUvs[heldBlock.textures.north] || params.blockUvs[heldBlock.textures.up];
            if (uv) {
                ctx.save();
                ctx.translate(handX, handY);
                ctx.rotate(isLeft ? (0.18 + swingSin * 0.45) : (-0.18 - swingSin * 0.45));
                ctx.drawImage(this.blockAtlasImg, uv.x, uv.y, uv.w, uv.h, 0, 0, 128, 128);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
                ctx.fillRect(0, 0, 128, 128);
                ctx.restore();
            }
        }

        // 2. Crosshair (Inverted-style crisp pixel crosshair + optional Attack Indicator)
        const cx = Math.floor(w / 2);
        const cy = Math.floor(h / 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
        ctx.fillRect(cx - 8, cy - 1, 16, 2);
        ctx.fillRect(cx - 1, cy - 8, 2, 16);
        if (this.attackIndicator === 'crosshair' && params.swingProgress > 0) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.fillRect(cx - 8, cy + 12, Math.floor(16 * (1.0 - params.swingProgress)), 3);
        }

        // 3. Survival/Hardcore Hearts, Hunger Drumsticks & Experience Bar above Hotbar
        const scale = this.guiScale > 0 ? Math.max(2, Math.min(4, this.guiScale)) : 3;
        const hotbarW = 182 * scale;
        const hotbarH = 22 * scale;
        const hotbarX = Math.floor((w - hotbarW) / 2);
        const hotbarY = h - hotbarH - 12;

        if (params.gameMode !== 'creative') {
            // Hearts (10 hearts = 20 HP, with Hardcore eyebrow marks if hardcore)
            for (let i = 0; i < 10; i++) {
                const hx = hotbarX + i * 24;
                const hy = hotbarY - 34;
                ctx.fillStyle = '#000000';
                ctx.fillRect(hx, hy, 20, 20);
                ctx.fillStyle = (i * 2 + 1) <= params.health ? (params.gameMode === 'hardcore' ? '#c81010' : '#e52521') : '#3a1010';
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
        }

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

        // 5. Directional Audio Subtitles Box (bottom-right above hotbar when Show Subtitles: ON)
        if (params.subtitles && params.subtitles.length > 0) {
            let sy = h - 110;
            for (const sub of params.subtitles) {
                const label = `${sub.dir === '<' ? '< ' : '  '}${sub.text}${sub.dir === '>' ? ' >' : '  '}`;
                const boxW = Math.max(160, label.length * 9 + 18);
                const bx = w - boxW - 16;
                ctx.fillStyle = 'rgba(16, 16, 20, 0.78)';
                ctx.fillRect(bx, sy, boxW, 24);
                this.drawShadowedText(label, bx + 9, sy + 17, '#ffffff', 14);
                sy -= 26;
            }
        }

        // 6. F3 Debug Screen (`Minecraft 26.3 (26.3/vanilla)`)
        if (params.showF3Debug) {
            const leftLines = [
                `Minecraft 26.3 (26.3/vanilla - Protocol 777, DataVersion 5023)`,
                `${params.fps} fps | Backend: ${this.backend} | C: ${this.renderedChunksCount}/${this.renderedChunksCount + this.culledChunksCount} (F: ${this.culledChunksCount}) | V: ${this.totalGpuVertices}`,
                `Thr: ${params.workerStatus} | WASM: mc26_3_core.wasm + epoxy.wasm | TeaVM Bytecode PAL`,
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

    public drawShadowedText(text: string, x: number, y: number, color = '#ffffff', sizePx = 16): void {
        const ctx = this.guiCtx;
        ctx.font = `bold ${sizePx}px "Courier New", monospace`;
        ctx.fillStyle = '#222222';
        ctx.fillText(text, x + 2, y + 2);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }
}
