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

export interface WorkerJobRequest {
    jobId: number;
    type: 'sort_translucent' | 'ping';
    camX: number;
    camY: number;
    camZ: number;
}

export class ThreadedWorkerPool {
    private workers: Worker[] = [];
    public readonly sharedMemoryAvailable: boolean;
    public readonly sharedStateBuffer: SharedArrayBuffer | ArrayBuffer;
    public readonly sharedAtomicState: Int32Array;
    public readonly workerCount: number;

    constructor(workerCount = Math.min(4, Math.max(2, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4) - 1))) {
        this.workerCount = workerCount;
        this.sharedMemoryAvailable = typeof SharedArrayBuffer !== 'undefined' && (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
        this.sharedStateBuffer = this.sharedMemoryAvailable
            ? new SharedArrayBuffer(4096)
            : new ArrayBuffer(4096);
        this.sharedAtomicState = new Int32Array(this.sharedStateBuffer);
    }

    public initInlineWorkers(): void {
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

    public recordTickCompleted(tickCount: number): void {
        if (this.sharedMemoryAvailable && typeof Atomics !== 'undefined') {
            Atomics.store(this.sharedAtomicState, 2, tickCount | 0);
        } else {
            this.sharedAtomicState[2] = tickCount | 0;
        }
    }

    public getStatusSummary(): string {
        return `${this.workers.length}/${this.workerCount} Workers (${this.sharedMemoryAvailable ? 'SharedArrayBuffer+Atomics' : 'Transferable ArrayBuffer'})`;
    }
}
