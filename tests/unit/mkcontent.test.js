import { describe, it, expect } from 'vitest';
import {
  fullToHalf,
  escapeSpecialMarkdownChar,
  getTitleLevel,
  mergeParaWithText,
  makeBlocksToMarkdown,
  makeBlocksToContentList,
  unionMake,
} from '@rapid_doc/backend/pipeline/pipeline_middle_json_mkcontent.js';
import { BlockType, ContentType, MakeMode } from '@rapid_doc/utils/enum_class.js';

// Helper to create a simple text block with lines/spans
function textBlock({ type = BlockType.TEXT, bbox = [0, 0, 100, 20], text = 'hello', level = null, pageSize = null } = {}) {
  const block = {
    type,
    bbox,
    lines: [
      {
        bbox: [...bbox],
        spans: [{ type: ContentType.TEXT, content: text, bbox: [...bbox] }],
      },
    ],
  };
  if (level != null) block.level = level;
  return block;
}

describe('mkcontent — fullToHalf', () => {
  it('converts full-width alphanumerics to half-width', () => {
    // U+FF21 = Ａ, U+FF41 = ａ, U+FF10 = ０
    expect(fullToHalf('Ａａ０')).toBe('Aa0');
    expect(fullToHalf('Ｈｅｌｌｏ')).toBe('Hello');
  });

  it('leaves half-width unchanged', () => {
    expect(fullToHalf('Hello 123')).toBe('Hello 123');
  });

  it('handles empty/null', () => {
    expect(fullToHalf('')).toBe('');
    expect(fullToHalf(null)).toBe('');
    expect(fullToHalf(undefined)).toBe('');
  });
});

describe('mkcontent — escapeSpecialMarkdownChar', () => {
  it('escapes *, `, ~', () => {
    expect(escapeSpecialMarkdownChar('a*b`c~d')).toBe('a\\*b\\`c\\~d');
  });

  it('leaves other chars', () => {
    expect(escapeSpecialMarkdownChar('hello_world')).toBe('hello_world');
  });

  it('handles empty', () => {
    expect(escapeSpecialMarkdownChar('')).toBe('');
    expect(escapeSpecialMarkdownChar(null)).toBe('');
  });
});

describe('mkcontent — getTitleLevel', () => {
  it('returns 1 by default', () => {
    expect(getTitleLevel(null)).toBe(1);
    expect(getTitleLevel({})).toBe(1);
  });

  it('clamps >4 to 4 and <1 to 0', () => {
    expect(getTitleLevel({ level: 5 })).toBe(4);
    expect(getTitleLevel({ level: 10 })).toBe(4);
    expect(getTitleLevel({ level: 0 })).toBe(0);
    expect(getTitleLevel({ level: -1 })).toBe(0);
  });

  it('returns exact 1-4', () => {
    expect(getTitleLevel({ level: 1 })).toBe(1);
    expect(getTitleLevel({ level: 3 })).toBe(3);
  });
});

describe('mkcontent — mergeParaWithText', () => {
  it('merges simple text block', () => {
    const block = textBlock({ text: 'hello world' });
    const got = mergeParaWithText(block);
    expect(got.trim()).toBe('hello world');
  });

  it('handles inline_equation delimiter', () => {
    const block = {
      type: BlockType.TEXT,
      bbox: [0, 0, 100, 20],
      lines: [
        {
          bbox: [0, 0, 100, 20],
          spans: [
            { type: ContentType.TEXT, content: 'E =', bbox: [0, 0, 20, 20] },
            { type: ContentType.INLINE_EQUATION, content: 'mc^2', bbox: [20, 0, 40, 20] },
          ],
        },
      ],
    };
    const got = mergeParaWithText(block);
    // inline delimiters default $...$
    expect(got).toContain('$mc^2$');
    expect(got).toContain('E =');
  });

  it('returns empty for null/empty lines', () => {
    expect(mergeParaWithText(null)).toBe('');
    expect(mergeParaWithText({ lines: [] })).toBe('');
  });
});

describe('mkcontent — makeBlocksToMarkdown', () => {
  it('renders text and title blocks', () => {
    const blocks = [
      textBlock({ type: BlockType.TITLE, text: 'My Title', level: 2 }),
      textBlock({ type: BlockType.TEXT, text: 'body paragraph' }),
    ];
    const md = makeBlocksToMarkdown(blocks, MakeMode.MM_MD, '');
    expect(md.join('\n')).toContain('## My Title');
    expect(md.join('\n')).toContain('body paragraph');
  });

  it('renders table html in MM_MD but not NLP_MD', () => {
    const tableBlock = {
      type: BlockType.TABLE,
      bbox: [0, 0, 100, 100],
      blocks: [
        {
          type: BlockType.TABLE_BODY,
          bbox: [0, 0, 100, 80],
          lines: [{ bbox: [0, 0, 100, 80], spans: [{ type: ContentType.TABLE, html: '<table><tr><td>hi</td></tr></table>', bbox: [0, 0, 100, 80] }] }],
        },
      ],
    };
    const mdMM = makeBlocksToMarkdown([tableBlock], MakeMode.MM_MD, '');
    expect(mdMM.join('')).toContain('<table>');
    const mdNLP = makeBlocksToMarkdown([tableBlock], MakeMode.NLP_MD, '');
    expect(mdNLP.length).toBe(0);
  });

  it('returns empty for empty input', () => {
    expect(makeBlocksToMarkdown([], MakeMode.MM_MD)).toEqual([]);
    expect(makeBlocksToMarkdown(null, MakeMode.MM_MD)).toEqual([]);
  });
});

describe('mkcontent — makeBlocksToContentList', () => {
  it('creates text content with bbox per-mille', () => {
    const block = textBlock({ type: BlockType.TEXT, bbox: [10, 20, 110, 40], text: 'hi' });
    const item = makeBlocksToContentList(block, 'images', 2, [200, 100]); // page 200w 100h
    expect(item.type).toBe(ContentType.TEXT);
    expect(item.page_idx).toBe(2);
    // bbox per-mille: floor(x*1000/W)
    expect(item.bbox).toEqual([50, 200, 550, 400]);
    expect(item.text.trim()).toBe('hi');
  });

  it('handles title level', () => {
    const block = textBlock({ type: BlockType.TITLE, bbox: [0, 0, 100, 20], text: 'Title', level: 3 });
    const item = makeBlocksToContentList(block, 'images', 0, [100, 100]);
    expect(item.text_level).toBe(3);
  });

  it('handles interline equation with/without latex', () => {
    const withLatex = {
      type: BlockType.INTERLINE_EQUATION,
      bbox: [0, 0, 100, 20],
      lines: [{ bbox: [0, 0, 100, 20], spans: [{ type: ContentType.INTERLINE_EQUATION, content: 'x^2', image_path: 'eq.png', bbox: [0, 0, 100, 20] }] }],
    };
    const item = makeBlocksToContentList(withLatex, 'imgs', 0, [100, 100]);
    expect(item.type).toBe(ContentType.EQUATION);
    expect(item.text_format).toBe('latex');

    const withoutLatex = {
      type: BlockType.INTERLINE_EQUATION,
      bbox: [0, 0, 100, 20],
      lines: [{ bbox: [0, 0, 100, 20], spans: [{ type: ContentType.INTERLINE_EQUATION, content: '', image_path: 'eq.png', bbox: [0, 0, 100, 20] }] }],
    };
    const item2 = makeBlocksToContentList(withoutLatex, 'imgs', 0, [100, 100]);
    expect(item2.img_path).toContain('eq.png');
  });

  it('returns null for null block', () => {
    expect(makeBlocksToContentList(null, '', 0, [100, 100])).toBeNull();
  });
});

describe('mkcontent — unionMake', () => {
  it('returns empty string/array for empty pdfInfo', () => {
    expect(unionMake([], MakeMode.MM_MD, '')).toBe('');
    expect(unionMake([], MakeMode.NLP_MD, '')).toBe('');
    expect(unionMake([], MakeMode.CONTENT_LIST, '')).toEqual([]);
    expect(unionMake(null, MakeMode.CONTENT_LIST, '')).toEqual([]);
  });

  it('produces markdown from pdf_info', () => {
    const pdfInfo = [
      {
        page_idx: 0,
        page_size: [100, 100],
        para_blocks: [textBlock({ type: BlockType.TITLE, text: 'T', level: 1 }), textBlock({ text: 'para' })],
        discarded_blocks: [],
      },
    ];
    const md = unionMake(pdfInfo, MakeMode.MM_MD, '');
    expect(typeof md).toBe('string');
    expect(md).toContain('# T');
    expect(md).toContain('para');
  });

  it('produces content_list with per-mille bboxes and page_idx', () => {
    const pdfInfo = [
      {
        page_idx: 1,
        page_size: [200, 200],
        para_blocks: [textBlock({ bbox: [0, 0, 100, 20], text: 'hi' })],
        discarded_blocks: [],
      },
    ];
    const list = unionMake(pdfInfo, MakeMode.CONTENT_LIST, 'imgs');
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].page_idx).toBe(1);
    expect(list[0].bbox).toEqual([0, 0, 500, 100]);
  });

  it('includes discarded_blocks in content_list', () => {
    const discarded = textBlock({ type: BlockType.DISCARDED, text: 'footer', bbox: [0, 90, 100, 100] });
    const pdfInfo = [
      {
        page_idx: 0,
        page_size: [100, 100],
        para_blocks: [textBlock({ text: 'main' })],
        discarded_blocks: [discarded],
      },
    ];
    const list = unionMake(pdfInfo, MakeMode.CONTENT_LIST, '');
    expect(list.some(i => i.text.includes('footer'))).toBe(true);
  });

  it('handles multi-page', () => {
    const makePage = (idx) => ({
      page_idx: idx,
      page_size: [100, 100],
      para_blocks: [textBlock({ text: `p${idx}` })],
      discarded_blocks: [],
    });
    const pdfInfo = [makePage(0), makePage(1), makePage(2)];
    const md = unionMake(pdfInfo, MakeMode.MM_MD, '');
    expect(md).toContain('p0');
    expect(md).toContain('p2');
    const list = unionMake(pdfInfo, MakeMode.CONTENT_LIST, '');
    expect(list.length).toBe(3);
  });

  it('returns null for unsupported mode', () => {
    const pdfInfo = [{ page_idx: 0, page_size: [100, 100], para_blocks: [textBlock({})], discarded_blocks: [] }];
    expect(unionMake(pdfInfo, 'unknown_mode', '')).toBeNull();
  });
});
