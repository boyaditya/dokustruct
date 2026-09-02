/**
 * Unit tests for LetterBox padding correctness .
 *
 * Verifies that LetterBox._padCenter does NOT halve bottom/right padding
 * when center=false. All padding should go to bottom/right only.
 *
 * Python reference (utils.py):
 *   if self.center:
 *       dw /= 2
 *       dh /= 2
 *   top = int(round(dh - 0.1)) if self.center else 0
 *   bottom = int(round(dh + 0.1))
 *   left = int(round(dw - 0.1)) if self.center else 0
 *   right = int(round(dw + 0.1))
 *
 *
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock cv (OpenCV.js) ──────────────────────────────────────────────────────
// LetterBox.call uses cv.resize and cv.copyMakeBorder. We mock these to
// record the border arguments without needing a real OpenCV build.

let lastBorderArgs = null;

const cv = {
  Mat: class MockMat {
    constructor() {
      this.rows = 0;
      this.cols = 0;
      this._deleted = false;
    }
    delete() { this._deleted = true; }
    empty() { return false; }
  },
  Size: class MockSize {
    constructor(w, h) { this.w = w; this.h = h; }
  },
  Scalar: class MockScalar {
    constructor(...args) { this.args = args; }
  },
  INTER_LINEAR: 1,
  BORDER_CONSTANT: 0,

  resize(src, dst, size) {
    dst.rows = size.h;
    dst.cols = size.w;
  },

  copyMakeBorder(src, dst, top, bottom, left, right, borderType, value) {
    lastBorderArgs = { top, bottom, left, right };
    dst.rows = src.rows + top + bottom;
    dst.cols = src.cols + left + right;
  },
};

// Inject cv as a global so the module can reference it (it uses /* global cv */)
global.cv = cv;

// ─── Import LetterBox after mocking cv ───────────────────────────────────────
// Dynamic import after cv is set up globally
let LetterBox;
beforeEach(async () => {
  // Reset border args for each test
  lastBorderArgs = null;
  if (!LetterBox) {
    const mod = await import(
      '../../rapid_doc/model/layout/rapid_layout_self/model_handler/doc_layout/utils.js'
    );
    LetterBox = mod.LetterBox;
  }
});

// ─── Helper: create a fake source image Mat ───────────────────────────────────
function makeImage(h, w) {
  const img = new cv.Mat();
  img.rows = h;
  img.cols = w;
  return img;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FIX L8 — LetterBox center=false: all padding on bottom/right', () => {
  it('center=false: top=0, left=0, full dh goes to bottom, full dw goes to right', () => {
    // 100x60 image → target 640x640
    // scale = min(640/100, 640/60) = min(6.4, ~10.67) = 6.4
    // newUnpadH = round(100 * 6.4) = 640 → no pad height needed? Let's use asymmetric input
    // 300x200 image → target 640x640
    // scale = min(640/300, 640/200) = min(~2.133, 3.2) = 2.133
    // newUnpadH = round(300 * 2.133) = round(639.9) = 640
    // newUnpadW = round(200 * 2.133) = round(426.7) = 427
    // dh = 640 - 640 = 0
    // dw = 640 - 427 = 213
    // center=false: top=0, bottom=round(0+0.1)=0, left=0, right=round(213+0.1)=213

    const lb = new LetterBox({ newShape: [640, 640], center: false });
    const img = makeImage(300, 200);
    lb.call(img);

    expect(lastBorderArgs.top).toBe(0);
    expect(lastBorderArgs.left).toBe(0);
    // right should be full dw (not halved)
    expect(lastBorderArgs.right).toBeGreaterThan(0);
    // In centered mode, right would be ~dw/2; here it must be ~dw (full)
    // With dw=213: right=round(213+0.1)=213, vs centered right=round(106.5+0.1)=107
    expect(lastBorderArgs.right).toBe(213);
    expect(lastBorderArgs.bottom).toBe(0);
  });

  it('center=false: padding only on bottom when image is wide (dh > 0)', () => {
    // 200x300 image → target 640x640
    // scale = min(640/200, 640/300) = min(3.2, ~2.133) = 2.133
    // newUnpadH = round(200 * 2.133) = round(426.6) = 427
    // newUnpadW = round(300 * 2.133) = round(639.9) = 640
    // dh = 640 - 427 = 213
    // dw = 640 - 640 = 0
    // center=false: top=0, bottom=round(213+0.1)=213, left=0, right=round(0+0.1)=0

    const lb = new LetterBox({ newShape: [640, 640], center: false });
    const img = makeImage(200, 300);
    lb.call(img);

    expect(lastBorderArgs.top).toBe(0);
    expect(lastBorderArgs.left).toBe(0);
    expect(lastBorderArgs.right).toBe(0);
    expect(lastBorderArgs.bottom).toBe(213);
  });

  it('center=false: output total size equals target shape', () => {
    // 480x640 image → target 800x800
    // scale = min(800/480, 800/640) = min(~1.667, 1.25) = 1.25
    // newUnpadH = round(480 * 1.25) = 600
    // newUnpadW = round(640 * 1.25) = 800
    // dh = 800 - 600 = 200
    // dw = 800 - 800 = 0
    // center=false: top=0, bottom=round(200+0.1)=200, left=0, right=round(0+0.1)=0

    const lb = new LetterBox({ newShape: [800, 800], center: false });
    const img = makeImage(480, 640);
    const result = lb.call(img);

    // Total height = 600 + 0 + 200 = 800
    expect(result.rows).toBe(800);
    // Total width = 800 + 0 + 0 = 800
    expect(result.cols).toBe(800);
    result.delete();
  });

  it('center=false: padRight is NOT half of what center=true gives', () => {
    // Same image, compare centered vs non-centered
    const img = makeImage(300, 200);

    const lbCentered = new LetterBox({ newShape: [640, 640], center: true });
    lbCentered.call(img);
    const centeredArgs = { ...lastBorderArgs };

    lastBorderArgs = null;

    const lbNonCentered = new LetterBox({ newShape: [640, 640], center: false });
    lbNonCentered.call(img);
    const nonCenteredArgs = { ...lastBorderArgs };

    // When center=false, all padding goes right; when center=true, it's split
    expect(nonCenteredArgs.left).toBe(0);
    expect(nonCenteredArgs.top).toBe(0);
    // Non-centered right should be approximately double centered right
    // (centered splits ~213/2 ≈ 106-107 each side; non-centered puts all 213 on right)
    expect(nonCenteredArgs.right).toBeGreaterThan(centeredArgs.right);
    expect(nonCenteredArgs.right + nonCenteredArgs.left).toBe(
      centeredArgs.right + centeredArgs.left
    );
    expect(nonCenteredArgs.bottom + nonCenteredArgs.top).toBe(
      centeredArgs.bottom + centeredArgs.top
    );
  });
});

describe('FIX L8 — LetterBox center=true: symmetric padding preserved', () => {
  it('center=true (default): padding split between top/bottom and left/right', () => {
    // 300x200 image → target 640x640 → dw=213, dh=0
    // center=true: left=round(213/2 - 0.1)=round(106.4)=106, right=round(106.5+0.1)=107
    // dh=0: top=round(0-0.1)=round(-0.1)=-0 (JS -0 == 0), bottom=round(0.1)=0
    const lb = new LetterBox({ newShape: [640, 640], center: true });
    const img = makeImage(300, 200);
    lb.call(img);

    // Use === 0 (not Object.is) to allow -0 (which is numerically identical)
    expect(lastBorderArgs.top === 0).toBe(true);
    expect(lastBorderArgs.bottom === 0).toBe(true);
    expect(lastBorderArgs.left).toBe(106);
    expect(lastBorderArgs.right).toBe(107);
  });

  it('center=true default constructor: center defaults to true', () => {
    // Default constructor should produce centered padding
    const lb = new LetterBox({ newShape: [640, 640] });
    const img = makeImage(300, 200);
    lb.call(img);

    // With center=true, both left and right are > 0
    expect(lastBorderArgs.left).toBeGreaterThan(0);
    expect(lastBorderArgs.right).toBeGreaterThan(0);
  });
});

describe('FIX L8 — LetterBox padding total invariant', () => {
  it('total padding (left+right) equals dw regardless of center flag', () => {
    // This invariant must hold for both center=true and center=false.
    // 400x250 → target 640x640
    // scale = min(640/400, 640/250) = min(1.6, 2.56) = 1.6
    // newUnpadH = round(400*1.6)=640, newUnpadW = round(250*1.6)=400
    // dh=0, dw=240

    const imgC = makeImage(400, 250);
    const lbC = new LetterBox({ newShape: [640, 640], center: true });
    lbC.call(imgC);
    const { left: lC, right: rC } = lastBorderArgs;

    const imgN = makeImage(400, 250);
    const lbN = new LetterBox({ newShape: [640, 640], center: false });
    lbN.call(imgN);
    const { left: lN, right: rN } = lastBorderArgs;

    expect(lC + rC).toBe(lN + rN); // total horizontal padding is the same
    expect(lN).toBe(0); // non-centered: all on right
    expect(rN).toBe(lC + rC); // non-centered right = total padding
  });
});
