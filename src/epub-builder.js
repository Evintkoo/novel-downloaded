import { EPub } from 'epub-gen-memory';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sanitizeFilename } from './utils.js';
import { fetchCoverImage } from './scraper.js';

export async function buildEpub(novelData, chapters, outputDir = 'output') {
  const { title, author, genres, description, coverUrl } = novelData;

  // Download cover image and save to temp file (epub-gen-memory expects a file path)
  let coverPath = null;
  if (coverUrl) {
    console.log('  Downloading cover image...');
    const coverBuffer = await fetchCoverImage(coverUrl);
    if (coverBuffer) {
      coverPath = path.join(os.tmpdir(), `novel-cover-${Date.now()}.jpg`);
      fs.writeFileSync(coverPath, coverBuffer);
    }
  }

  const customCss = `
    body { font-family: Georgia, serif; line-height: 1.6; margin: 1em; }
    h1.chapter-title {
      page-break-before: always;
      margin-top: 2em;
      margin-bottom: 1em;
      font-size: 1.4em;
      text-align: center;
    }
    p { text-indent: 1.5em; margin: 0.4em 0; }
  `;

  const options = {
    title: title || 'Unknown Title',
    author: author || 'Unknown Author',
    description: description || '',
    tocTitle: 'Table of Contents',
    css: customCss,
  };

  if (coverPath) {
    options.cover = coverPath;
  }

  const emptyCount = chapters.filter(ch => !ch.content || ch.content.trim() === '').length;
  if (emptyCount > 0) {
    console.warn(`  Warning: ${emptyCount} chapter${emptyCount > 1 ? 's' : ''} with empty content.`);
  }

  const epubChapters = chapters.map((ch) => {
    const chTitle = ch.title || 'Untitled Chapter';
    const body = ch.content || '<p>No content available.</p>';
    return {
      title: chTitle,
      content: `<h1 class="chapter-title">${chTitle}</h1>\n${body}`,
    };
  });

  console.log(`  Generating EPUB for "${title}"...`);
  const epubBuffer = await new EPub(options, epubChapters).genEpub();

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = `${sanitizeFilename(title)}.epub`;
  const outputPath = path.join(outputDir, filename);

  fs.writeFileSync(outputPath, epubBuffer);

  // Clean up temp cover file
  if (coverPath) {
    try { fs.unlinkSync(coverPath); } catch {}
  }

  console.log(`  Saved: ${outputPath}`);
  return outputPath;
}
