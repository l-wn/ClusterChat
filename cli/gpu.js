// WebGPU for Node: Dawn's bindings (the `webgpu` package, the same Dawn that
// is in Chrome), loaded only when this machine lends its GPU, so a chat-only
// start does not pay for it. `openGpu()` returns the stand-in for
// navigator.gpu that Engine.connect() takes as `platform.gpu`.

import { adapterLabel } from '../web/model/kernels.js';

let loaded = null;

export function openGpu() {
    loaded ??= (async () => {
        let mod;
        try {
            mod = await import('webgpu');
        } catch (err) {
            throw new Error(`no GPU runtime for this platform (${err.message.split('\n')[0]}). `
                + 'Reinstall clusterchat, or lend from the cluster page in Chrome.');
        }
        // GPUBufferUsage, GPUMapMode and the rest, which the kernels use as globals.
        for (const [k, v] of Object.entries(mod.globals)) globalThis[k] ??= v;
        return mod.create([]);
    })();
    return loaded;
}

// The adapter the engine would use, for `clusterchat gpu` and the question
// before lending: { gpu, label, f16 }, or null with no usable GPU.
export async function probeGpu() {
    const gpu = await openGpu();
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    return { gpu, label: await adapterLabel(adapter), f16: adapter.features.has('shader-f16'),
             maxBuffer: adapter.limits.maxBufferSize };
}
