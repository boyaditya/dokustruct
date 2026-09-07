import { describe, it, expect } from 'vitest';
import {
  getLineHeight,
  insertLinesIntoBlock,
  addLinesToBlocks,
  extractBlockOriginalOrder,
  revertGroupBlocks,
  processBlockList,
} from '@rapid_doc/utils/block_sort.js';
import { BlockType, ContentType } from '@rapid_doc/utils/enum_class.js';

describe('block_sort — getLineHeight', () => {
  it('returns 10 for empty', () => {
    expect(getLineHeight([])).toBe(10);
    expect(getLineHeight(null)).toBe(10);
  });

  it('computes median line height from text blocks', () => {
    const blocks = [
      { type: BlockType.TEXT, lines: [{ bbox: [0, 0, 10, 10] }, { bbox: [0, 10, 10, 20] }] },
      { type: BlockType.TITLE, lines: [{ bbox: [0, 0, 10, 15] }] },
      { type: BlockType.IMAGE_BODY, lines: [{ bbox: [0, 0, 10, 100] }] }, // should be ignored (not text type)
    ];
    // heights: 10,10,15 → sorted [10,10,15] median=10
    expect(getLineHeight(blocks)).toBe(10);
  });

  it('ignores non-text types', () => {
    const blocks = [{ type: BlockType.TABLE_BODY, lines: [{ bbox: [0, 0, 10, 100] }] }];
    expect(getLineHeight(blocks)).toBe(10);
  });
});

describe('block_sort — insertLinesIntoBlock', () => {
  it('returns empty for invalid bbox', () => {
    expect(insertLinesIntoBlock(null, 10, 100, 100)).toEqual([]);
    expect(insertLinesIntoBlock([0, 0], 10, 100, 100)).toEqual([]);
  });

  it('returns single bbox when blockHeight <= 2*lineHeight', () => {
    const bbox = [0, 0, 100, 15];
    const lines = insertLinesIntoBlock(bbox, 10, 100, 100);
    expect(lines).toEqual([[0, 0, 100, 15]]);
  });

  it('splits tall block into multiple lines', () => {
    const bbox = [0, 0, 100, 60];
    const lines = insertLinesIntoBlock(bbox, 10, 100, 100);
    // blockHeight 60 > 20, blockWidth 100 > pageW*0.4 (40) → lines=3
    expect(lines.length).toBe(3);
    // total height preserved
    expect(lines[0][1]).toBe(0);
    expect(lines[2][3]).toBe(60);
  });

  it('returns single for very narrow tall block (vertical)', () => {
    const bbox = [0, 0, 10, 50]; // w=10, h=50, h/w=5 >1.2 → single
    const lines = insertLinesIntoBlock(bbox, 10, 100, 100);
    expect(lines).toEqual([[0, 0, 10, 50]]);
  });
});

describe('block_sort — addLinesToBlocks', () => {
  it('adds lines to text blocks without lines', () => {
    const blocks = [{ type: BlockType.TEXT, bbox: [0, 0, 100, 30], lines: [] }];
    addLinesToBlocks(blocks, 100, 100, 10, []);
    expect(blocks[0].lines.length).toBeGreaterThan(0);
  });

  it('does not add duplicate lines when already present (except TITLE tall)', () => {
    const blocks = [{ type: BlockType.TEXT, bbox: [0, 0, 100, 15], lines: [{ bbox: [0, 0, 100, 15], spans: [] }] }];
    addLinesToBlocks(blocks, 100, 100, 10, []);
    expect(blocks[0].lines.length).toBe(1);
  });

  it('splits TITLE with height > 2*lineHeight', () => {
    const blocks = [{ type: BlockType.TITLE, bbox: [0, 0, 100, 60], lines: [{ bbox: [0, 0, 100, 60], spans: [] }] }];
    addLinesToBlocks(blocks, 100, 100, 10, []);
    expect(blocks[0].lines.length).toBeGreaterThan(1);
    expect(blocks[0].real_lines).toBeDefined();
  });

  it('handles no-op for null', () => {
    expect(() => addLinesToBlocks(null, 100, 100, 10, [])).not.toThrow();
  });
});

describe('block_sort — extractBlockOriginalOrder', () => {
  it('returns block.original_order when present', () => {
    expect(extractBlockOriginalOrder({ original_order: 5 })).toBe(5);
    expect(extractBlockOriginalOrder({ original_order: 0 })).toBe(0);
  });

  it('returns min span order when block order missing', () => {
    const block = {
      lines: [
        { spans: [{ original_order: 3 }, { original_order: 1 }] },
        { spans: [{ original_order: 2 }] },
      ],
    };
    expect(extractBlockOriginalOrder(block)).toBe(1);
  });

  it('returns -1 when no order', () => {
    expect(extractBlockOriginalOrder({ lines: [] })).toBe(-1);
    expect(extractBlockOriginalOrder(null)).toBe(-1);
    expect(extractBlockOriginalOrder({})).toBe(-1);
  });

  it('ignores negative orders', () => {
    expect(extractBlockOriginalOrder({ original_order: -1, lines: [{ spans: [{ original_order: -1 }] }] })).toBe(-1);
  });
});

describe('block_sort — revertGroupBlocks / processBlockList', () => {
  it('reverts IMAGE_BODY/CAPTION groups into IMAGE', () => {
    const blocks = [
      { type: BlockType.TEXT, bbox: [0, 0, 10, 10], index: 0 },
      { type: BlockType.IMAGE_BODY, bbox: [0, 10, 50, 30], group_id: 'g1', index: 1, polygon_points: [0, 10, 50, 10, 50, 30, 0, 30] },
      { type: BlockType.IMAGE_CAPTION, bbox: [0, 30, 50, 40], group_id: 'g1', index: 2 },
    ];
    const out = revertGroupBlocks(blocks);
    expect(out.some(b => b.type === BlockType.IMAGE)).toBe(true);
    expect(out.find(b => b.type === BlockType.IMAGE).blocks.length).toBe(2);
    expect(out.some(b => b.type === BlockType.TEXT)).toBe(true);
  });

  it('reverts TABLE groups', () => {
    const blocks = [
      { type: BlockType.TABLE_BODY, bbox: [0, 0, 50, 50], group_id: 't1', index: 0 },
      { type: BlockType.TABLE_CAPTION, bbox: [0, 50, 50, 60], group_id: 't1', index: 1 },
    ];
    const out = revertGroupBlocks(blocks);
    expect(out.some(b => b.type === BlockType.TABLE)).toBe(true);
  });

  it('handles empty', () => {
    expect(revertGroupBlocks([])).toEqual([]);
    expect(revertGroupBlocks(null)).toEqual([]);
  });

  it('processBlockList creates parent with median index and bbox', () => {
    const blocks = [
      { type: BlockType.IMAGE_BODY, bbox: [0, 0, 50, 50], index: 5, polygon_points: [0, 0, 50, 0, 50, 50, 0, 50] },
      { type: BlockType.IMAGE_CAPTION, bbox: [0, 50, 50, 60], index: 6 },
    ];
    const parent = processBlockList(blocks, BlockType.IMAGE_BODY, BlockType.IMAGE);
    expect(parent.type).toBe(BlockType.IMAGE);
    expect(parent.bbox).toEqual([0, 0, 50, 50]);
    expect(parent.index).toBe(5.5); // median of [5,6]
    expect(parent.polygon_points).toBeDefined();
  });
});
