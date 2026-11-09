/**
 * Web Audio API 3D OpenAL Spatial Sound Engine
 *
 * Replicates `com.mojang.blaze3d.audio.Library` & `Channel` (LWJGL OpenAL bindings)
 * in the browser using `AudioContext`, `AudioListener`, `PannerNode` (HRTF / inverse
 * distance attenuation with clamping), Doppler pitch shift, and `.ogg` Vorbis decoding
 * from `assets/sounds/*.ogg`.
 */

export enum SoundSource {
    MASTER = 'master',
    MUSIC = 'music',
    RECORDS = 'record',
    WEATHER = 'weather',
    BLOCKS = 'block',
    HOSTILE = 'hostile',
    NEUTRAL = 'neutral',
    PLAYERS = 'player',
    AMBIENT = 'ambient',
    VOICE = 'voice',
}

export class OpenALAudioEngine {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private categoryGains: Map<SoundSource, GainNode> = new Map();
    private bufferCache: Map<string, AudioBuffer> = new Map();
    private loadingPromises: Map<string, Promise<AudioBuffer | null>> = new Map();
    private soundEvents: Record<string, string[]> = {};
    private listenerX = 0;
    private listenerY = 64;
    private listenerZ = 0;
    private listenerVx = 0;
    private listenerVy = 0;
    private listenerVz = 0;

    public setSoundEventsRegistry(events: Record<string, string[]>): void {
        this.soundEvents = events;
    }

    public ensureContext(): AudioContext | null {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().catch(() => {});
            }
            return this.ctx;
        }
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

    public setCategoryVolume(source: SoundSource, volume: number): void {
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
    public updateListener(
        x: number, y: number, z: number,
        yawRad: number, pitchRad: number,
        vx = 0, vy = 0, vz = 0
    ): void {
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
            (listener as AudioListener & {
                setPosition(x: number, y: number, z: number): void;
                setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
            }).setPosition(x, y, z);
            (listener as AudioListener & {
                setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
            }).setOrientation(fx, fy, fz, ux, uy, uz);
        }
    }

    private async loadOggBuffer(soundPath: string): Promise<AudioBuffer | null> {
        const ctx = this.ensureContext();
        if (!ctx) return null;
        const flatName = soundPath.replace(/\//g, '_');
        if (this.bufferCache.has(flatName)) return this.bufferCache.get(flatName)!;
        if (this.loadingPromises.has(flatName)) return this.loadingPromises.get(flatName)!;

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
    public async playSoundEvent(
        eventId: string,
        source: SoundSource = SoundSource.BLOCKS,
        x = this.listenerX,
        y = this.listenerY,
        z = this.listenerZ,
        volume = 1.0,
        pitch = 1.0,
        spatial = true,
        sourceVx = 0,
        sourceVy = 0,
        sourceVz = 0
    ): Promise<void> {
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

        const catGain = this.categoryGains.get(source) || this.masterGain!;
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
    private playSynthesizedFallback(
        ctx: AudioContext,
        cleanEvent: string,
        source: SoundSource,
        x: number, y: number, z: number,
        volume: number, pitch: number,
        spatial: boolean
    ): void {
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

        const catGain = this.categoryGains.get(source) || this.masterGain!;
        osc.connect(gain);
        gain.connect(catGain);
        osc.start(now);
        osc.stop(now + 0.095);
    }
}
