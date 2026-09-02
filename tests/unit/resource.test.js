import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deleteMat,
  deleteMatList,
  clearLayoutImageList,
  releaseCanvas,
  releaseImageBitmap,
  withMats,
} from '@rapid_doc/utils/resource_utils.js';

/**
 * Property: Resource Cleanup Invariant
 *
 * For any valid input processed through the pipeline, whether the processing
 * succeeds or fails with an error, the total number of cv.Mat allocations
 * should equal the total number of cv.Mat.delete calls, and all
 * OffscreenCanvas/ImageBitmap resources should be released.
 *
 * , 5.2, 5.3, 5.4
 */

/**
 * Creates a mock cv.Mat with tracking for delete calls.
 */
function createMockMat(deleted = false) {
  let isDeleted = deleted;
  const mat = {
    delete: vi.fn(() => { isDeleted = true; }),
    isDeleted: vi.fn(() => isDeleted),
  };
  return mat;
}

// Setup global cv mock before each test
beforeEach(() => {
  globalThis.cv = {
    Mat: class Mat {},
  };
});

afterEach(() => {
  delete globalThis.cv;
});

describe('Property 3: Resource Cleanup Invariant — withMats pattern', () => {
  it('cleans up all Mats on successful operation', async () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    const mat3 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);
    Object.setPrototypeOf(mat3, cv.Mat.prototype);

    const result = await withMats(
      () => [mat1, mat2, mat3],
      (mats) => mats.reduce((sum, _) => sum + 1, 0),
    );

    expect(result).toBe(3);
    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
    expect(mat3.delete).toHaveBeenCalledOnce();
  });

  it('cleans up all Mats when operation throws synchronously', async () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);

    await expect(
      withMats(
        () => [mat1, mat2],
        () => { throw new Error('sync failure'); },
      ),
    ).rejects.toThrow('sync failure');

    // Cleanup invariant: all Mats deleted even on error
    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
  });

  it('cleans up all Mats when async operation rejects', async () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);

    await expect(
      withMats(
        () => [mat1, mat2],
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('async failure');
        },
      ),
    ).rejects.toThrow('async failure');

    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
  });

  it('allocation count equals delete count on success path', async () => {
    const mats = Array.from({ length: 5 }, () => {
      const m = createMockMat();
      Object.setPrototypeOf(m, cv.Mat.prototype);
      return m;
    });

    await withMats(
      () => mats,
      (allocated) => {
        // Simulate some work with the mats
        return allocated.length;
      },
    );

    const deleteCount = mats.filter((m) => m.delete.mock.calls.length > 0).length;
    expect(deleteCount).toBe(mats.length);
  });

  it('allocation count equals delete count on error path', async () => {
    const mats = Array.from({ length: 5 }, () => {
      const m = createMockMat();
      Object.setPrototypeOf(m, cv.Mat.prototype);
      return m;
    });

    await expect(
      withMats(
        () => mats,
        () => { throw new Error('processing error'); },
      ),
    ).rejects.toThrow();

    const deleteCount = mats.filter((m) => m.delete.mock.calls.length > 0).length;
    expect(deleteCount).toBe(mats.length);
  });

  it('returns undefined when factory is null (no allocation, no leak)', async () => {
    const result = await withMats(null, () => 42);
    expect(result).toBeUndefined();
  });

  it('returns undefined when operation is null (no execution, no leak)', async () => {
    const result = await withMats(() => [], null);
    expect(result).toBeUndefined();
  });

  it('handles factory returning empty array gracefully', async () => {
    const result = await withMats(
      () => [],
      (mats) => mats.length,
    );
    expect(result).toBe(0);
  });
});

describe('Property 3: Resource Cleanup Invariant — deleteMat null-safety', () => {
  it('does not throw for null input', () => {
    expect(() => deleteMat(null)).not.toThrow();
  });

  it('does not throw for undefined input', () => {
    expect(() => deleteMat(undefined)).not.toThrow();
  });

  it('does not throw for numeric input', () => {
    expect(() => deleteMat(0)).not.toThrow();
    expect(() => deleteMat(42)).not.toThrow();
  });

  it('does not throw for string input', () => {
    expect(() => deleteMat('')).not.toThrow();
    expect(() => deleteMat('mat')).not.toThrow();
  });

  it('does not throw for plain object (non-Mat)', () => {
    expect(() => deleteMat({ delete: vi.fn() })).not.toThrow();
  });

  it('does not throw for already-deleted Mat', () => {
    const mat = createMockMat(true);
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    expect(() => deleteMat(mat)).not.toThrow();
    expect(mat.delete).not.toHaveBeenCalled();
  });

  it('does not throw when cv is undefined', () => {
    delete globalThis.cv;
    expect(() => deleteMat({ delete: vi.fn() })).not.toThrow();
  });

  it('calls delete() exactly once for a valid Mat', () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    deleteMat(mat);
    expect(mat.delete).toHaveBeenCalledOnce();
  });
});

describe('Property 3: Resource Cleanup Invariant — deleteMatList null-safety', () => {
  it('does not throw for null input', () => {
    expect(() => deleteMatList(null)).not.toThrow();
  });

  it('does not throw for undefined input', () => {
    expect(() => deleteMatList(undefined)).not.toThrow();
  });

  it('does not throw for non-array input (number)', () => {
    expect(() => deleteMatList(123)).not.toThrow();
  });

  it('does not throw for non-array input (string)', () => {
    expect(() => deleteMatList('mats')).not.toThrow();
  });

  it('does not throw for non-array input (object)', () => {
    expect(() => deleteMatList({ length: 2 })).not.toThrow();
  });

  it('does not throw for empty array', () => {
    expect(() => deleteMatList([])).not.toThrow();
  });

  it('skips null/undefined entries without throwing', () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    expect(() => deleteMatList([null, undefined, mat, null])).not.toThrow();
    expect(mat.delete).toHaveBeenCalledOnce();
  });

  it('deletes all valid Mats in the list', () => {
    const mats = Array.from({ length: 3 }, () => {
      const m = createMockMat();
      Object.setPrototypeOf(m, cv.Mat.prototype);
      return m;
    });
    deleteMatList(mats);
    for (const m of mats) {
      expect(m.delete).toHaveBeenCalledOnce();
    }
  });
});
