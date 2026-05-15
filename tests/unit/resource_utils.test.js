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
 * Mock cv.Mat for testing resource cleanup behavior.
 */
function createMockMat(deleted = false) {
  let isDeleted = deleted;
  const mat = {
    delete: vi.fn(() => { isDeleted = true; }),
    isDeleted: vi.fn(() => isDeleted),
  };
  return mat;
}

// Setup global cv mock
beforeEach(() => {
  globalThis.cv = {
    Mat: class Mat {},
  };
});

afterEach(() => {
  delete globalThis.cv;
});

describe('deleteMat', () => {
  it('deletes a valid Mat', () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    deleteMat(mat);
    expect(mat.delete).toHaveBeenCalledOnce();
  });

  it('does nothing for null input', () => {
    expect(() => deleteMat(null)).not.toThrow();
  });

  it('does nothing for undefined input', () => {
    expect(() => deleteMat(undefined)).not.toThrow();
  });

  it('does nothing for already-deleted Mat', () => {
    const mat = createMockMat(true);
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    deleteMat(mat);
    expect(mat.delete).not.toHaveBeenCalled();
  });

  it('does nothing for non-Mat objects', () => {
    const obj = { delete: vi.fn(), isDeleted: () => false };
    deleteMat(obj);
    expect(obj.delete).not.toHaveBeenCalled();
  });

  it('does nothing when cv is undefined', () => {
    delete globalThis.cv;
    const mat = { delete: vi.fn(), isDeleted: () => false };
    expect(() => deleteMat(mat)).not.toThrow();
  });
});

describe('deleteMatList', () => {
  it('deletes all Mats in an array', () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);
    deleteMatList([mat1, mat2]);
    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
  });

  it('does nothing for null input', () => {
    expect(() => deleteMatList(null)).not.toThrow();
  });

  it('does nothing for undefined input', () => {
    expect(() => deleteMatList(undefined)).not.toThrow();
  });

  it('does nothing for non-array input', () => {
    expect(() => deleteMatList('not an array')).not.toThrow();
  });

  it('handles empty array', () => {
    expect(() => deleteMatList([])).not.toThrow();
  });

  it('skips null entries in the array', () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);
    expect(() => deleteMatList([null, mat, undefined])).not.toThrow();
    expect(mat.delete).toHaveBeenCalledOnce();
  });
});

describe('clearLayoutImageList', () => {
  it('deletes pil_image Mats from layout_image_list', () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);
    const tableRes = {
      layout_image_list: [{ pil_image: mat1 }, { pil_image: mat2 }],
    };
    clearLayoutImageList(tableRes);
    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
    expect(tableRes.layout_image_list).toBeUndefined();
  });

  it('does nothing for null input', () => {
    expect(() => clearLayoutImageList(null)).not.toThrow();
  });

  it('does nothing for undefined input', () => {
    expect(() => clearLayoutImageList(undefined)).not.toThrow();
  });

  it('handles tableRes without layout_image_list', () => {
    const tableRes = { html: '<table></table>' };
    expect(() => clearLayoutImageList(tableRes)).not.toThrow();
  });

  it('handles items with null pil_image', () => {
    const tableRes = {
      layout_image_list: [{ pil_image: null }, {}],
    };
    expect(() => clearLayoutImageList(tableRes)).not.toThrow();
  });

  it('removes layout_image_list property after cleanup', () => {
    const tableRes = { layout_image_list: [] };
    clearLayoutImageList(tableRes);
    expect('layout_image_list' in tableRes).toBe(false);
  });
});

describe('releaseCanvas', () => {
  it('sets canvas dimensions to 0x0', () => {
    const canvas = { width: 800, height: 600 };
    releaseCanvas(canvas);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('does nothing for null input', () => {
    expect(() => releaseCanvas(null)).not.toThrow();
  });

  it('does nothing for undefined input', () => {
    expect(() => releaseCanvas(undefined)).not.toThrow();
  });

  it('handles canvas that throws on property set', () => {
    const canvas = {};
    Object.defineProperty(canvas, 'width', {
      set() { throw new Error('detached'); },
      get() { return 0; },
    });
    expect(() => releaseCanvas(canvas)).not.toThrow();
  });
});

describe('releaseImageBitmap', () => {
  it('calls close() on a valid bitmap', () => {
    const bitmap = { close: vi.fn() };
    releaseImageBitmap(bitmap);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('does nothing for null input', () => {
    expect(() => releaseImageBitmap(null)).not.toThrow();
  });

  it('does nothing for undefined input', () => {
    expect(() => releaseImageBitmap(undefined)).not.toThrow();
  });

  it('does nothing for object without close method', () => {
    const bitmap = { width: 100, height: 100 };
    expect(() => releaseImageBitmap(bitmap)).not.toThrow();
  });

  it('handles bitmap that throws on close', () => {
    const bitmap = { close: vi.fn(() => { throw new Error('already closed'); }) };
    expect(() => releaseImageBitmap(bitmap)).not.toThrow();
  });
});

describe('withMats', () => {
  it('passes factory result to operation and returns result', async () => {
    const mat1 = createMockMat();
    const mat2 = createMockMat();
    Object.setPrototypeOf(mat1, cv.Mat.prototype);
    Object.setPrototypeOf(mat2, cv.Mat.prototype);

    const result = await withMats(
      () => [mat1, mat2],
      (mats) => mats.length
    );

    expect(result).toBe(2);
    expect(mat1.delete).toHaveBeenCalledOnce();
    expect(mat2.delete).toHaveBeenCalledOnce();
  });

  it('cleans up Mats even when operation throws', async () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);

    await expect(
      withMats(
        () => [mat],
        () => { throw new Error('operation failed'); }
      )
    ).rejects.toThrow('operation failed');

    expect(mat.delete).toHaveBeenCalledOnce();
  });

  it('returns undefined for null factory', async () => {
    const result = await withMats(null, () => 42);
    expect(result).toBeUndefined();
  });

  it('returns undefined for null operation', async () => {
    const result = await withMats(() => [], null);
    expect(result).toBeUndefined();
  });

  it('handles async operations', async () => {
    const mat = createMockMat();
    Object.setPrototypeOf(mat, cv.Mat.prototype);

    const result = await withMats(
      () => [mat],
      async (mats) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return mats.length * 10;
      }
    );

    expect(result).toBe(10);
    expect(mat.delete).toHaveBeenCalledOnce();
  });

  it('handles factory returning empty array', async () => {
    const result = await withMats(
      () => [],
      (mats) => mats.length
    );
    expect(result).toBe(0);
  });
});
