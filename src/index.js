import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import cliProgress from 'cli-progress';
import pLimit from 'p-limit';
import { fetchNovelList, fetchNovelDetail, fetchChapterContent } from './scraper.js';
import { buildEpub } from './epub-builder.js';
import { delay, sanitizeFilename } from './utils.js';

function printUsage() {
  console.log(`
Novel Scraper & EPUB Generator
===============================

Usage:
  node src/index.js --pages <N>                 List completed novels (20 per page)
  node src/index.js --novel <slug>              Download a novel and generate EPUB
  node src/index.js --url <url>                 Download from a freewebnovel.com URL
  node src/index.js --all --pages <N>           Download ALL novels from listing pages

Options:
  --pages <N>         Number of listing pages to scrape (default: 1)
  --novel <slug>      Novel slug to download (e.g., "omegas-rebirth")
  --url <url>         Full novel URL (e.g., "https://freewebnovel.com/novel/omegas-rebirth")
  --all               Download all novels from the listing pages
  --delay <ms>        Delay between requests in ms (default: 1000)
  --concurrency <N>   Parallel chapter downloads (default: 3)
  --output <dir>      Output directory (default: "output")
  --help              Show this help message
`);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      pages: { type: 'string', short: 'p' },
      novel: { type: 'string', short: 'n' },
      url: { type: 'string', short: 'u' },
      all: { type: 'boolean', short: 'a' },
      delay: { type: 'string', short: 'd' },
      concurrency: { type: 'string', short: 'c' },
      output: { type: 'string', short: 'o' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  // Extract slug from URL if provided
  let novelSlug = values.novel || null;
  if (!novelSlug && values.url) {
    const match = values.url.match(/\/novel\/([^/]+)/);
    if (match) {
      novelSlug = match[1];
    } else {
      console.error(`Invalid URL: ${values.url}`);
      console.error('Expected format: https://freewebnovel.com/novel/<slug>');
      process.exit(1);
    }
  }

  const pages = values.pages ? parseInt(values.pages, 10) : null;
  const delayMs = values.delay ? parseInt(values.delay, 10) : 1000;
  const concurrency = values.concurrency ? parseInt(values.concurrency, 10) : 3;

  if (pages !== null && (!Number.isFinite(pages) || pages < 1)) {
    console.error('Error: --pages must be a positive integer');
    process.exit(1);
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    console.error('Error: --delay must be a non-negative integer');
    process.exit(1);
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error('Error: --concurrency must be a positive integer');
    process.exit(1);
  }

  return {
    pages,
    novel: novelSlug,
    all: values.all || false,
    delayMs,
    concurrency,
    outputDir: values.output || 'output',
    help: values.help || false,
  };
}

async function fetchListingPages(pages, delayMs) {
  console.log(`\nFetching completed novel listings (${pages} page${pages > 1 ? 's' : ''})...\n`);

  const allNovels = [];

  for (let p = 1; p <= pages; p++) {
    console.log(`  Page ${p}/${pages}...`);
    const novels = await fetchNovelList(p, delayMs);
    allNovels.push(...novels);

    if (p < pages) {
      await delay(delayMs);
    }
  }

  return allNovels;
}

function printNovelTable(novels) {
  console.log('\n' + '-'.repeat(90));
  console.log(
    'Slug'.padEnd(35) +
    'Title'.padEnd(35) +
    'Chapters'.padEnd(10) +
    'Genres'
  );
  console.log('-'.repeat(90));

  for (const novel of novels) {
    console.log(
      novel.slug.padEnd(35).slice(0, 34) + ' ' +
      novel.title.padEnd(35).slice(0, 34) + ' ' +
      String(novel.chapterCount).padEnd(10) +
      novel.genres.slice(0, 3).join(', ')
    );
  }

  console.log('-'.repeat(90));
  console.log(`\nTotal: ${novels.length} novels found.`);
}

async function listMode(pages, delayMs) {
  const allNovels = await fetchListingPages(pages, delayMs);

  if (allNovels.length === 0) {
    console.log('No novels found.');
    return;
  }

  printNovelTable(allNovels);
  console.log('\nTo download a novel:');
  console.log('  node src/index.js --novel <slug>');
  console.log('\nTo download ALL novels:');
  console.log('  node src/index.js --all --pages <N>\n');
}

function epubExists(title, outputDir) {
  const filename = `${sanitizeFilename(title)}.epub`;
  return fs.existsSync(path.join(outputDir, filename));
}

async function downloadNovel(slug, delayMs, concurrency, outputDir) {
  const novel = await fetchNovelDetail(slug);

  if (!novel.title) {
    console.error(`  Could not find novel with slug: ${slug}`);
    return false;
  }

  // Skip if EPUB already exists
  if (epubExists(novel.title, outputDir)) {
    console.log(`  Skipping "${novel.title}" — EPUB already exists.`);
    return true;
  }

  console.log(`  Title:    ${novel.title}`);
  console.log(`  Author:   ${novel.author}`);
  console.log(`  Genres:   ${novel.genres.join(', ')}`);
  console.log(`  Chapters: ${novel.chapters.length}`);

  if (novel.chapters.length === 0) {
    console.error(`  No chapters found for "${novel.title}".`);
    return false;
  }

  // Download chapters in parallel with p-limit
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

  // First pass — parallel download
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
        chapters[i] = null; // mark for retry
      }
      bar.update(++completed);
    })
  );

  await Promise.all(tasks);
  bar.stop();

  // Multi-pass retry for failed/empty chapters
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

  // Fill remaining failures with error placeholders
  let failedChapters = 0;
  const failedList = [];
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i] === null) {
      failedChapters++;
      failedList.push(i + 1);
      chapters[i] = {
        title: novel.chapters[i].title || `Chapter ${i + 1}`,
        content: `<p>[Failed to fetch after retries]</p>`,
      };
    }
  }

  if (failedChapters > 0) {
    console.log(`  Downloaded ${novel.chapters.length - failedChapters}/${novel.chapters.length} chapters (${failedChapters} failed).`);
    console.log(`  Failed chapters: ${failedList.join(', ')}`);
  } else {
    console.log(`  All ${novel.chapters.length} chapters downloaded.`);
  }

  // Build EPUB
  const outputPath = await buildEpub(
    {
      title: novel.title,
      author: novel.author,
      genres: novel.genres,
      description: novel.description,
      coverUrl: novel.coverUrl,
    },
    chapters,
    outputDir
  );

  console.log(`  Saved: ${outputPath}`);
  return true;
}

async function downloadSingleMode(slug, delayMs, concurrency, outputDir) {
  console.log(`\nFetching novel details for "${slug}"...\n`);
  const success = await downloadNovel(slug, delayMs, concurrency, outputDir);
  if (success) {
    console.log('\nDone!\n');
  } else {
    process.exit(1);
  }
}

async function downloadAllMode(pages, delayMs, concurrency, outputDir) {
  const allNovels = await fetchListingPages(pages, delayMs);

  if (allNovels.length === 0) {
    console.log('No novels found.');
    return;
  }

  printNovelTable(allNovels);

  console.log(`\nStarting batch download of ${allNovels.length} novels...\n`);

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < allNovels.length; i++) {
    const novel = allNovels[i];
    console.log(`\n[${ i + 1}/${allNovels.length}] ${novel.title} (${novel.slug})`);

    try {
      // Check if already exists before fetching details
      if (epubExists(novel.title, outputDir)) {
        console.log(`  Skipping — EPUB already exists.`);
        skipped++;
        continue;
      }

      await delay(delayMs); // Delay between novels
      const success = await downloadNovel(novel.slug, delayMs, concurrency, outputDir);
      if (success) {
        succeeded++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('Batch download complete!');
  console.log(`  Succeeded: ${succeeded}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Total:     ${allNovels.length}`);
  console.log('='.repeat(50) + '\n');
}

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (args.novel) {
    await downloadSingleMode(args.novel, args.delayMs, args.concurrency, args.outputDir);
  } else if (args.all) {
    const pages = args.pages || 1;
    await downloadAllMode(pages, args.delayMs, args.concurrency, args.outputDir);
  } else {
    const pages = args.pages || 1;
    await listMode(pages, args.delayMs);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
