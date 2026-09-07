import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  acquireGlobalGpu,
  isGpuDeviceLost,
  clearGpuDeviceLostFlag,
  getGpuDevice,
  isSharedGpuDeviceAvailable,
  getAdapterMetadata,
  isOrtRuntimeConfigured,
} from '@rapid_doc/utils/ort_runtime.js';

describe('ort_runtime — acquireGlobalGpu mutex', () => {
  it('serializes concurrent gpu runs (FIFO)', async () => {
    const order = [];
    const run = async (id, delay) => {
      const release = await acquireGlobalGpu();
      order.push(`acquire-${id}`);
      await new Promise(r => setTimeout(r, delay));
      order.push(`release-${id}`);
      release();
    };
    await Promise.all([run(1, 15), run(2, 5), run(3, 5)]);
    // With mutex, acquires are serialized: 1,2,3
    expect(order).toEqual([
      'acquire-1', 'release-1',
      'acquire-2', 'release-2',
      'acquire-3', 'release-3',
    ]);
  });

  it('returns a release function', async () => {
    const release = await acquireGlobalGpu();
    expect(typeof release).toBe('function');
    release();
  });

  it('second acquirer waits for first release', async () => {
    let secondAcquired = false;
    const release1 = await acquireGlobalGpu();
    const p2 = acquireGlobalGpu().then(r => { secondAcquired = true; return r; });
    expect(secondAcquired).toBe(false);
    release1();
    const release2 = await p2;
    expect(secondAcquired).toBe(true);
    release2();
  });

  it('mutex remains functional after many cycles', async () => {
    for (let i = 0; i < 10; i++) {
      const rel = await acquireGlobalGpu();
      rel();
    }
    const rel = await acquireGlobalGpu();
    expect(typeof rel).toBe('function');
    rel();
  });
});

describe('ort_runtime — device lost flag', () => {
  afterEach(() => {
    // do not leave deviceLost=true leaking into other tests
    clearGpuDeviceLostFlag();
  });

  it('initially not lost', () => {
    clearGpuDeviceLostFlag();
    expect(isGpuDeviceLost()).toBe(false);
  });

  it('clearGpuDeviceLostFlag resets', () => {
    // We cannot directly set deviceLost without importing internals,
    // but we can at least verify clear does not throw and leaves false
    expect(() => clearGpuDeviceLostFlag()).not.toThrow();
    expect(isGpuDeviceLost()).toBe(false);
  });
});

describe('ort_runtime — adapter/device accessors', () => {
  it('getGpuDevice returns null or object (no throw)', () => {
    expect(() => getGpuDevice()).not.toThrow();
    const dev = getGpuDevice();
    expect(dev === null || typeof dev === 'object').toBe(true);
  });

  it('isSharedGpuDeviceAvailable returns bool|null', () => {
    const v = isSharedGpuDeviceAvailable();
    expect(v === null || typeof v === 'boolean').toBe(true);
  });

  it('getAdapterMetadata returns null or object', () => {
    const m = getAdapterMetadata();
    expect(m === null || typeof m === 'object').toBe(true);
    if (m) {
      expect(typeof m.label).toBe('string');
      expect(typeof m.looksIntegrated).toBe('boolean');
    }
  });

  it('isOrtRuntimeConfigured returns boolean', () => {
    expect(typeof isOrtRuntimeConfigured()).toBe('boolean');
  });
});
