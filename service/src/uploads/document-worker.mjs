// Untrusted documents are parsed in a short-lived, memory/time-bounded process.
import { readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const MAX_TEXT = 1_000_000;
const clean = text => text.replace(/\u0000/g, '\ufffd');
process.once('message', async ({ path, name, mime, page }) => {
  try {
    const bytes = await readFile(path);
    const pdf = bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'));
    let pages = [], warnings = [], complete = true;
    if (pdf) {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({ standardFontDataUrl: new URL('standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).pathname, data: new Uint8Array(bytes), useSystemFonts: false,
        isEvalSupported: false, stopAtErrors: true, maxImageSize: 16_000_000 });
      const document = await task.promise;
      try {
        if (page) {
          if (page > document.numPages) throw Error('file_page_not_found');
          const selected = await document.getPage(page);
          const original = selected.getViewport({ scale: 1 });
          const scale = Math.min(2, 1400 / Math.max(original.width, original.height));
          const viewport = selected.getViewport({ scale });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await selected.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          return process.send({ image: canvas.toBuffer('image/jpeg', 80).toString('base64'), page_count: document.numPages });
        }
        let total = 0;
        for (let index = 1; index <= Math.min(document.numPages, 200); index++) {
          const selected = await document.getPage(index);
          const content = await selected.getTextContent();
          const text = clean(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
          pages.push(text.slice(0, MAX_TEXT - total)); total += text.length;
          selected.cleanup();
          if (total >= MAX_TEXT) { complete = false; warnings.push('Text limit reached.'); break; }
        }
        if (document.numPages > pages.length) { complete = false; warnings.push(`Only ${pages.length} of ${document.numPages} pages extracted.`); }
        if (pages.some(text => !text.trim())) {
          complete = false; warnings.push('Some pages have no extractable text. Use files_read with page to inspect the rendered page; do not assume blank pages.');
        }
      } finally { await task.destroy(); }
    } else if (page && /^(image\/(png|jpeg|webp))$/.test(mime)) {
      if (page !== 1) throw Error('file_page_not_found');
      const image = await loadImage(bytes);
      if (image.width * image.height > 40_000_000) throw Error('file_image_too_large');
      const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
      const canvas = createCanvas(Math.ceil(image.width * scale), Math.ceil(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return process.send({ image: canvas.toBuffer('image/jpeg', 80).toString('base64'), page_count: 1 });
    } else if (page) throw Error('file_page_rendering_unsupported');
    else if (/\.docx$/i.test(name) && bytes.subarray(0, 2).toString() === 'PK') {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: bytes });
      const text = clean(result.value);
      pages = [text.slice(0, MAX_TEXT)];
      complete = text.length <= MAX_TEXT;
      if (!complete) warnings.push('Text limit reached.');
      if (result.messages.length) { complete = false; warnings.push('Document contains elements the text extractor may omit.'); }
    } else if (/\.(txt|md|csv|json|log|yaml|yml|xml)$/i.test(name) || mime.startsWith('text/')) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.includes('\u0000')) throw Error('file_binary_content');
      pages = [text.slice(0, MAX_TEXT)]; complete = text.length <= MAX_TEXT;
      if (!complete) warnings.push('Text limit reached.');
    } else throw Error('file_reading_unsupported');
    process.send({ pages, complete, warnings });
  } catch (error) {
    process.send({ error: /^file_[a-z_]+$/.test(error.message) ? error.message : 'file_unreadable' });
  }
});
