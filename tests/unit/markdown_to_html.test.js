import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '@rapid_doc/utils/markdown_to_html.js';

describe('markdown_to_html', () => {
  it('produces full HTML document with title and default CSS', async () => {
    const html = await markdownToHtml('# Hello\n\nWorld', { title: 'Test Doc' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Test Doc</title>');
    expect(html).toContain('<h1>Hello</h1>');
    expect(html).toContain('World');
    expect(html).toContain('<style>');
    expect(html).toContain('MathJax');
  });

  it('escapes title HTML', async () => {
    const html = await markdownToHtml('hi', { title: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses customCss when provided', async () => {
    const html = await markdownToHtml('hi', { title: 't', customCss: '.custom{}' });
    expect(html).toContain('.custom{}');
    expect(html).not.toContain('--bg-color'); // default should be replaced
  });

  it('handles empty markdown', async () => {
    const html = await markdownToHtml('', { title: 'empty' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('empty');
  });

  it('renders tables and code', async () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\ncode\n```';
    const html = await markdownToHtml(md, { title: 't' });
    expect(html).toContain('<table>');
    expect(html).toContain('<code');
  });

  it('includes MathJax config', async () => {
    const html = await markdownToHtml('$x^2$', { title: 'math' });
    expect(html).toContain('tex:');
    expect(html).toContain('cdn.jsdelivr.net/npm/mathjax');
  });
});
