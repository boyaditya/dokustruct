// Copyright (c) Opendatalab. All rights reserved.
/**
 * PORTING NOTE: markdown_to_html.py → markdown_to_html.js
 *
 * WORKAROUND: markdown-it-py + mdit-py-plugins + pygments
 * REASON: Python Markdown libs not available in browser
 * SOLUTION: Use `marked` (npm) for Markdown→HTML; MathJax CDN for math rendering.
 *   Code highlighting is omitted (no Pygments equivalent bundled).
 *
 * WORKAROUND: open(output_path, 'w') for writing HTML file
 * REASON: No filesystem in browser
 * SOLUTION: Return HTML string only; caller handles saving (e.g., Blob download).
 *
 * WORKAROUND: embed_images from local filesystem
 * REASON: No filesystem access
 * SOLUTION: embed_images with fetch-based base64 encoding via URL.
 */

/**
 * Default CSS for the generated HTML output.
 * PORTING NOTE: DEFAULT_HTML_CSS constant → same content
 */
const DEFAULT_HTML_CSS = `
:root {
  --bg-color: #ffffff; --text-color: #24292e; --code-bg: #f6f8fa;
  --border-color: #e1e4e8; --link-color: #0366d6; --blockquote-color: #6a737d;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.6; color: var(--text-color);
  background-color: var(--bg-color); max-width: 900px; margin: 0 auto; padding: 20px 45px;
}
h1,h2,h3,h4,h5,h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25;
  border-bottom: 1px solid var(--border-color); padding-bottom: .3em; }
h1 { font-size: 2em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; border-bottom: none; }
h4,h5,h6 { border-bottom: none; }
p { margin-top: 0; margin-bottom: 16px; }
a { color: var(--link-color); text-decoration: none; } a:hover { text-decoration: underline; }
code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 85%;
  background-color: var(--code-bg); padding: 0.2em 0.4em; border-radius: 6px; }
pre { background-color: var(--code-bg); border-radius: 6px; padding: 16px; overflow: auto;
  font-size: 85%; line-height: 1.45; }
pre code { background: transparent; padding: 0; font-size: 100%; }
blockquote { margin: 0; padding: 0 1em; color: var(--blockquote-color); border-left: 0.25em solid var(--border-color); }
table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
table th, table td { padding: 6px 13px; border: 1px solid var(--border-color); }
table th { font-weight: 600; background-color: var(--code-bg); }
table tr:nth-child(2n) { background-color: #f6f8fa; }
img { max-width: 100%; height: auto; display: block; margin: 16px 0; }
hr { height: 0.25em; padding: 0; margin: 24px 0; background-color: var(--border-color); border: 0; }
.math-block { display: block; text-align: center; margin: 1em 0; }
.math-inline { display: inline; }
.MathJax { display: inline-block; margin: 0; }
.MathJax_Display { display: block; margin: 1em 0; text-align: center; }
`;

/**
 * Convert Markdown to a full HTML document string.
 * PORTING NOTE: markdown_to_html(...) → async markdownToHtml(...)
 *
 * @param {string} markdownContent
 * @param {object} [opts]
 * @param {string} [opts.title='Markdown Document']
 * @param {string|null} [opts.customCss=null]
 * @param {boolean} [opts.embedImages=false]
 * @param {string|null} [opts.imageBasePath=null]
 * @returns {Promise<string>} Full HTML string
 */
export async function markdownToHtml(markdownContent, {
  title = 'Markdown Document',
  customCss = null,
  embedImages = false,
  imageBasePath = null,
} = {}) {
  const { marked } = await import('marked');

  // Configure marked
  marked.setOptions({ gfm: true, breaks: false });

  let htmlBody = marked.parse(markdownContent);

  // Embed images if requested (fetch-based)
  if (embedImages && imageBasePath) {
    const imgRe = /src="([^"]+)"/g;
    const replacements = [];
    let match;
    while ((match = imgRe.exec(htmlBody)) !== null) {
      const src = match[1];
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) continue;
      const url = imageBasePath.endsWith('/') ? imageBasePath + src : `${imageBasePath}/${src}`;
      replacements.push({ original: match[0], url });
    }
    for (const { original, url } of replacements) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const buf = await resp.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const ext = url.split('.').pop().toLowerCase();
          const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg+xml' };
          const mime = mimeMap[ext] ?? 'png';
          htmlBody = htmlBody.replace(original, `src="data:image/${mime};base64,${b64}"`);
        }
      } catch { /* ignore */ }
    }
  }

  const css = customCss ?? DEFAULT_HTML_CSS;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
  <script>
    MathJax = {
      tex: {
        inlineMath: [['$','$'],['\\\\(','\\\\)']],
        displayMath: [['$$','$$'],['\\\\[','\\\\]']],
        processEscapes: true, processEnvironments: true
      },
      options: { skipHtmlTags: ['script','noscript','style','textarea','pre','code'] }
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js" async></script>
</head>
<body>
${htmlBody}
</body>
</html>`;
}

/**
 * Escape HTML special chars.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
