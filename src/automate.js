import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fetchNovelList, fetchNovelDetail, fetchChapterContent } from './scraper.js';
import { buildEpub } from './epub-builder.js';
import { delay, sanitizeFilename } from './utils.js';
import { syncLibrary } from '../sync-library.js';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';

// Prevent stray socket errors from crashing the process
process.on('uncaughtException', (err) => {
  if (err.code === 'ENETUNREACH' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
    console.error(`  Network error (ignored): ${err.code}`);
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const OUTPUT_DIR = 'output';
const LIBRARY_DIR = 'docs/epubs';
const NOVEL_LIST_CACHE = path.join(OUTPUT_DIR, 'novel-list.json');

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      pages: { type: 'string', short: 'p' },
      delay: { type: 'string', short: 'd' },
      concurrency: { type: 'string', short: 'c' },
      'max-chapters': { type: 'string', short: 'm' },
      refresh: { type: 'boolean', short: 'r' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  return {
    pages: values.pages ? parseInt(values.pages, 10) : 1,
    delayMs: values.delay ? parseInt(values.delay, 10) : 1000,
    concurrency: values.concurrency ? parseInt(values.concurrency, 10) : 3,
    maxChapters: values['max-chapters'] ? parseInt(values['max-chapters'], 10) : 2000,
    refresh: values.refresh || false,
    help: values.help || false,
  };
}

function loadCachedNovelList() {
  try {
    if (fs.existsSync(NOVEL_LIST_CACHE)) {
      const data = JSON.parse(fs.readFileSync(NOVEL_LIST_CACHE, 'utf-8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch {}
  return null;
}

function saveCachedNovelList(novels) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(NOVEL_LIST_CACHE, JSON.stringify(novels, null, 2));
}

function epubExists(title) {
  const filename = `${sanitizeFilename(title)}.epub`;
  return fs.existsSync(path.join(OUTPUT_DIR, filename));
}

async function downloadNovel(slug, delayMs, concurrency, maxChapters) {
  const novel = await fetchNovelDetail(slug);

  if (!novel.title) {
    console.error(`  Could not find novel with slug: ${slug}`);
    return false;
  }

  console.log(`  Title:    ${novel.title}`);
  console.log(`  Author:   ${novel.author}`);
  console.log(`  Chapters: ${novel.chapters.length}`);

  if (novel.chapters.length === 0) {
    console.error(`  No chapters found for "${novel.title}".`);
    return false;
  }

  if (maxChapters && novel.chapters.length > maxChapters) {
    console.log(`  Skipping — ${novel.chapters.length} chapters exceeds limit of ${maxChapters}.`);
    return false;
  }

  const bar = new cliProgress.SingleBar({
    format: '  Downloading [{bar}] {percentage}% | {value}/{total} chapters',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });

  bar.start(novel.chapters.length, 0);

  const chapters = new Array(novel.chapters.length);
  const limit = pLimit(concurrency);
  let completed = 0;

  const tasks = novel.chapters.map((ch, i) =>
    limit(async () => {
      if (i > 0) await delay(delayMs);
      try {
        const content = await fetchChapterContent(ch.url);
        if (!content.content || content.content.trim() === '') {
          throw new Error('Empty content returned');
        }
        chapters[i] = {
          title: content.title || ch.title,
          content: content.content,
        };
      } catch {
        chapters[i] = null;
      }
      bar.update(++completed);
    })
  );

  await Promise.all(tasks);
  bar.stop();

  // Multi-pass retry
  const MAX_RETRY_PASSES = 2;
  for (let pass = 1; pass <= MAX_RETRY_PASSES; pass++) {
    const failedIndices = chapters
      .map((ch, i) => (ch === null ? i : -1))
      .filter(i => i !== -1);

    if (failedIndices.length === 0) break;

    console.log(`  Retry pass ${pass}: ${failedIndices.length} chapter${failedIndices.length > 1 ? 's' : ''} to retry...`);
    await delay(delayMs * 2);

    const retryBar = new cliProgress.SingleBar({
      format: '  Retrying  [{bar}] {percentage}% | {value}/{total} chapters',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
    });
    retryBar.start(failedIndices.length, 0);
    let retryCompleted = 0;

    const retryTasks = failedIndices.map(i =>
      limit(async () => {
        await delay(delayMs);
        const ch = novel.chapters[i];
        try {
          const content = await fetchChapterContent(ch.url);
          if (!content.content || content.content.trim() === '') {
            throw new Error('Empty content returned');
          }
          chapters[i] = {
            title: content.title || ch.title,
            content: content.content,
          };
        } catch {
          chapters[i] = null;
        }
        retryBar.update(++retryCompleted);
      })
    );

    await Promise.all(retryTasks);
    retryBar.stop();
  }

  // Fill remaining failures
  let failedChapters = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i] === null) {
      failedChapters++;
      chapters[i] = {
        title: novel.chapters[i].title || `Chapter ${i + 1}`,
        content: `<p>[Failed to fetch after retries]</p>`,
      };
    }
  }

  if (failedChapters > 0) {
    console.log(`  ${failedChapters} chapter${failedChapters > 1 ? 's' : ''} failed after retries.`);
  }

  await buildEpub(
    {
      title: novel.title,
      author: novel.author,
      genres: novel.genres,
      description: novel.description,
      coverUrl: novel.coverUrl,
    },
    chapters,
    OUTPUT_DIR
  );

  return true;
}

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    console.log(`
Automate Novel Library
=======================
Downloads novels from listing pages, generates EPUBs, and syncs to web library.

Usage:
  node src/automate.js --pages <N>
  npm run automate -- --pages 3

Options:
  --pages <N>          Number of listing pages to fetch (default: 1, ~20 novels/page)
  --delay <ms>         Delay between requests in ms (default: 1000)
  --concurrency <N>    Parallel chapter downloads (default: 3)
  --max-chapters <N>   Skip novels with more than N chapters (default: 2000)
  --refresh            Force re-crawl listing pages even if cached
  --help               Show this help message
`);
    process.exit(0);
  }

  console.log(`\n=== Automate Novel Library ===\n`);

  // Step 1: Get novel list (from cache or by crawling)
  const cached = !args.refresh ? loadCachedNovelList() : null;
  let allNovels;

  if (cached) {
    console.log(`Step 1: Using cached novel list (${cached.length} novels). Use --refresh to re-crawl.\n`);
    allNovels = cached;
  } else {
    console.log(`Step 1: Fetching novel listings (${args.pages} page${args.pages > 1 ? 's' : ''})...\n`);

    allNovels = [];
    for (let p = 1; p <= args.pages; p++) {
      console.log(`  Page ${p}/${args.pages}...`);
      const novels = await fetchNovelList(p, args.delayMs);
      allNovels.push(...novels);
      if (p < args.pages) await delay(args.delayMs);
    }

    saveCachedNovelList(allNovels);
    console.log(`  Cached ${allNovels.length} novels to ${NOVEL_LIST_CACHE}`);
  }

  console.log(`\n  Found ${allNovels.length} novels.\n`);

  if (allNovels.length === 0) {
    console.log('No novels found. Exiting.');
    return;
  }

  // Step 2: Download each novel
  console.log(`Step 2: Downloading novels...\n`);

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < allNovels.length; i++) {
    const novel = allNovels[i];
    console.log(`[${i + 1}/${allNovels.length}] ${novel.title} (${novel.slug})`);

    try {
      if (epubExists(novel.title)) {
        console.log(`  Skipping — EPUB already exists.`);
        skipped++;
        continue;
      }

      await delay(args.delayMs);
      const result = await downloadNovel(novel.slug, args.delayMs, args.concurrency, args.maxChapters);
      if (result) {
        succeeded++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      failed++;
    }

    console.log('');
  }

  console.log(`\nStep 2 Summary:`);
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);

  // Step 3: Sync to library
  console.log(`\nStep 3: Syncing to web library...\n`);

  await syncLibrary(OUTPUT_DIR, LIBRARY_DIR);

  console.log(`\n=== Done! ===\n`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
