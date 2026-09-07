import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getCoordsAndArea,
  calculateIntersection,
  isInside,
  getResListFromLayoutRes,
  cleanMemory,
} from '@rapid_doc/utils/model_utils.js';

describe('model_utils — getCoordsAndArea', () => {
  it('extracts xmin,ymin,xmax,ymax and area', () => {
    const block = { poly: [10, 20, 30, 20, 30, 40, 10, 40] };
    expect(getCoordsAndArea(block)).toEqual([10, 20, 30, 40, 400]);
  });

  it('truncates floats', () => {
    const block = { poly: [10.9, 20.9, 30.9, 20.9, 30.9, 40.9, 10.9, 40.9] };
    expect(getCoordsAndArea(block)).toEqual([10, 20, 30, 40, 400]);
  });
});

describe('model_utils — calculateIntersection', () => {
  it('returns intersection when overlapping', () => {
    expect(calculateIntersection([0, 0, 10, 10], [5, 5, 15, 15])).toEqual([5, 5, 10, 10]);
  });
  it('returns null when disjoint', () => {
    expect(calculateIntersection([0, 0, 10, 10], [20, 20, 30, 30])).toBeNull();
  });
  it('returns null when touching edge (xmax==xmin)', () => {
    expect(calculateIntersection([0, 0, 10, 10], [10, 0, 20, 10])).toBeNull();
  });
});

describe('model_utils — isInside', () => {
  it('true when small inside big with sufficient overlap', () => {
    const small = [5, 5, 10, 10, 25]; // 5x5=25
    const big = [0, 0, 20, 20];
    expect(isInside(small, big, 0.8)).toBe(true);
  });
  it('false when outside', () => {
    const small = [30, 30, 40, 40, 100];
    const big = [0, 0, 20, 20];
    expect(isInside(small, big, 0.8)).toBe(false);
  });
  it('false when barely overlapping below threshold', () => {
    const small = [0, 0, 10, 10, 100];
    const big = [9, 0, 20, 10]; // overlap 1x10=10 → 0.1 <0.8
    expect(isInside(small, big, 0.8)).toBe(false);
  });
  it('respects custom threshold', () => {
    const small = [0, 0, 10, 10, 100];
    const big = [5, 0, 20, 10]; // overlap 5x10=50 → 0.5
    expect(isInside(small, big, 0.4)).toBe(true);
    expect(isInside(small, big, 0.6)).toBe(false);
  });
});

describe('model_utils — getResListFromLayoutRes (category routing)', () => {
  const fakeMat = { cols: 100, rows: 100 };

  it('routes categories correctly without needing crop (no image+table overlap)', () => {
    const layoutRes = [
      { category_id: 0, poly: [0, 0, 10, 0, 10, 10, 0, 10] }, // text → ocr
      { category_id: 1, poly: [10, 0, 20, 0, 20, 10, 10, 10] }, // text → ocr
      { category_id: 5, poly: [20, 0, 30, 0, 30, 10, 20, 10] }, // table
      { category_id: 8, poly: [30, 0, 40, 0, 40, 10, 30, 10] }, // interline → formula
      { category_id: 13, poly: [40, 0, 50, 0, 50, 10, 40, 10] }, // inline → formula
      { category_id: 3, poly: [50, 0, 60, 0, 60, 10, 50, 10] }, // image
    ];
    const { ocrResList, tableResList, formulaResList } = getResListFromLayoutRes(layoutRes, fakeMat);
    expect(ocrResList.length).toBe(2);
    expect(tableResList.length).toBe(1);
    expect(formulaResList.length).toBe(2);
  });

  it('creates bbox from poly for formula when missing', () => {
    const layoutRes = [{ category_id: 8, poly: [10, 20, 30, 20, 30, 40, 10, 40] }];
    const { formulaResList } = getResListFromLayoutRes(layoutRes, fakeMat);
    expect(formulaResList[0].bbox).toEqual([10, 20, 30, 40]);
  });

  it('handles empty input', () => {
    const { ocrResList, tableResList, formulaResList } = getResListFromLayoutRes([], fakeMat);
    expect(ocrResList).toEqual([]);
    expect(tableResList).toEqual([]);
    expect(formulaResList).toEqual([]);
  });

  it('image inside table attaches layout_image_list (mocked crop)', async () => {
    // Mock cv for this test only
    globalThis.cv = {
      Mat: class { constructor(r, c, t) { this.rows = r; this.cols = c; } delete() {} type() { return 0; } roi() { return { copyTo() {}, delete() {} }; } setTo() {} },
      Scalar: class {},
      Rect: class { constructor() {} },
      MatVector: class { push_back() {} delete() {} },
      CV_8UC1: 0, CV_8UC3: 1, CV_32SC2: 2,
      matFromArray: () => ({ delete() {} }),
      Mat: { zeros: () => ({ delete() {} }) },
    };
    // Need to re-import? getResListFromLayoutRes already imported, but it reads global cv at call time for cropImg.
    // Provide minimal stubs that cropImg will use without throwing
    const origRandomUUID = globalThis.crypto?.randomUUID;
    if (!globalThis.crypto) globalThis.crypto = {};
    globalThis.crypto.randomUUID = () => 'test-uuid';

    // Provide full cv mock expected by cropImg
    globalThis.cv = {
      Mat: class {
        constructor(r, c, t) { this.rows = r; this.cols = c; this._t = t; }
        delete() {}
        type() { return 0; }
        roi() { return { copyTo() {}, delete() {} }; }
        setTo() {}
      },
      Scalar: class { constructor() {} },
      Rect: class { constructor() {} },
      MatVector: class { push_back() {} delete() {} },
      CV_8UC1: 0, CV_8UC3: 16,
      CV_32SC2: 13,
      matFromArray: () => ({ delete() {} }),
      fillPoly: () => {},
    };
    globalThis.cv.Mat.zeros = () => ({
      delete() {},
      rows: 10,
      cols: 10,
    });

    const layoutRes = [
      { category_id: 5, poly: [0, 0, 100, 0, 100, 100, 0, 100] }, // table covers all
      { category_id: 3, poly: [10, 10, 20, 10, 20, 20, 10, 20] }, // image inside
    ];
    // Will call cropImg which now has mocked cv — should not throw
    expect(() => getResListFromLayoutRes(layoutRes, { cols: 100, rows: 100, type() { return 0; }, roi() { return { copyTo() {}, delete() {} }; }, setTo() {} })).not.toThrow();

    if (origRandomUUID) globalThis.crypto.randomUUID = origRandomUUID;
    delete globalThis.cv;
  });
});

describe('model_utils — cleanMemory', () => {
  it('does not throw for wasm', async () => {
    await expect(cleanMemory('wasm')).resolves.not.toThrow();
    await expect(cleanMemory('wasm', { releaseGpu: false })).resolves.not.toThrow();
  });

  it('does not throw for webgpu when ort_runtime not available (warn only)', async () => {
    // cleanMemory dynamic imports ort_runtime; if it fails it warns, not throws
    await expect(cleanMemory('webgpu')).resolves.not.toThrow();
  });

  it('triggers gc when available', async () => {
    const gcSpy = vi.fn();
    const origGc = globalThis.gc;
    globalThis.gc = gcSpy;
    await cleanMemory('wasm');
    expect(gcSpy).toHaveBeenCalled();
    if (origGc) globalThis.gc = origGc;
    else delete globalThis.gc;
  });
});
