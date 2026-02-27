import { parentPort, workerData } from 'node:worker_threads';
import { fetchNovelDetail, fetchChapterContent } from './scraper.js';
import { buildEpub } from './epub-builder.js';
import { delay } from './utils.js';
import pLimit from 'p-limit';

const { delayMs, concurrency, maxChapters, outputDir } = workerData;

parentPort.on('message', async (msg) => {
  if (msg.type === 'download') {
    const { slug, title } = msg;
    try {
      const result = await downloadNovel(slug, title);
      parentPort.postMessage({ type: 'result', slug, ...result });
    } catch (err) {
      parentPort.postMessage({ type: 'result', slug, success: false, error: err.message });
    }
  } else if (msg.type === 'exit') {
    process.exit(0);
  }
});

async function downloadNovel(slug, listTitle) {
  const novel = await fetchNovelDetail(slug);

  if (!novel.title) {
    return { success: false, error: `Could not find novel: ${slug}` };
  }

  if (novel.chapters.length === 0) {
    return { success: false, error: `No chapters found for "${novel.title}"` };
  }

  if (maxChapters && novel.chapters.length > maxChapters) {
    return { success: false, error: `${novel.chapters.length} chapters exceeds limit of ${maxChapters}`, skipped: true };
  }

  // Download chapters with concurrency limit
  const chapters = new Array(novel.chapters.length);
  const limit = pLimit(concurrency);
  let completed = 0;

  const tasks = novel.chapters.map((ch, i) =>
    limit(async () => {
      if (i > 0) await delay(delayMs);
      try {
        const content = await fetchChapterContent(ch.url);
        if (!content.content || content.content.trim() === '') {
          throw new Error('Empty content');
        }
        chapters[i] = { title: content.title || ch.title, content: content.content };
      } catch {
        chapters[i] = null;
      }
      completed++;
      // Report progress periodically
      if (completed % 20 === 0 || completed === novel.chapters.length) {
        parentPort.postMessage({
          type: 'progress',
          slug,
          title: novel.title,
          completed,
          total: novel.chapters.length,
        });
      }
    })
  );

  await Promise.all(tasks);

  // Retry failed chapters
  for (let pass = 1; pass <= 2; pass++) {
    const failedIndices = chapters.map((ch, i) => (ch === null ? i : -1)).filter(i => i !== -1);
    if (failedIndices.length === 0) break;

    await delay(delayMs * 2);

    const retryTasks = failedIndices.map(i =>
      limit(async () => {
        await delay(delayMs);
        const ch = novel.chapters[i];
        try {
          const content = await fetchChapterContent(ch.url);
          if (!content.content || content.content.trim() === '') throw new Error('Empty');
          chapters[i] = { title: content.title || ch.title, content: content.content };
        } catch {
          chapters[i] = null;
        }
      })
    );

    await Promise.all(retryTasks);
  }

  // Fill failures with placeholders
  let failedCount = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i] === null) {
      failedCount++;
      chapters[i] = {
        title: novel.chapters[i].title || `Chapter ${i + 1}`,
        content: `<p>[Failed to fetch after retries]</p>`,
      };
    }
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
    outputDir
  );

  return {
    success: true,
    title: novel.title,
    totalChapters: novel.chapters.length,
    failedChapters: failedCount,
  };
}

// Signal ready
parentPort.postMessage({ type: 'ready' });
