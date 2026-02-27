import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchNovelList } from './scraper.js';
import { delay, sanitizeFilename } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Prevent stray socket errors from crashing the process
process.on('uncaughtException', (err) => {
  if (['ENETUNREACH', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) return;
  console.error('Uncaught exception:', err);
  process.exit(1);
});

const OUTPUT_DIR = 'output';
const NOVEL_LIST_CACHE = path.join(OUTPUT_DIR, 'novel-list.json');

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      pages:          { type: 'string', short: 'p' },
      workers:        { type: 'string', short: 'w' },
      delay:          { type: 'string', short: 'd' },
      concurrency:    { type: 'string', short: 'c' },
      'max-chapters': { type: 'string', short: 'm' },
      refresh:        { type: 'boolean', short: 'r' },
      help:           { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  return {
    pages:       values.pages ? parseInt(values.pages, 10) : 1,
    workers:     values.workers ? parseInt(values.workers, 10) : 4,
    delayMs:     values.delay ? parseInt(values.delay, 10) : 1000,
    concurrency: values.concurrency ? parseInt(values.concurrency, 10) : 3,
    maxChapters: values['max-chapters'] ? parseInt(values['max-chapters'], 10) : 2000,
    refresh:     values.refresh || false,
    help:        values.help || false,
  };
}

function printUsage() {
  console.log(`
Worker-Based Novel Crawler
===========================
Crawls novel listing pages and downloads novels in parallel using worker threads.

Usage:
  node src/worker-manager.js --pages <N> --workers <N>
  npm run crawl -- --pages 5 --workers 4

Options:
  --pages <N>          Listing pages to crawl (default: 1, ~20 novels/page)
  --workers <N>        Number of parallel worker threads (default: 4)
  --delay <ms>         Delay between requests per worker (default: 1000)
  --concurrency <N>    Parallel chapter downloads per worker (default: 3)
  --max-chapters <N>   Skip novels exceeding N chapters (default: 2000)
  --refresh            Force re-crawl listing pages (ignore cache)
  --help               Show this help message
`);
}

// ── Novel list management ──

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

// ── Worker pool ──

class WorkerPool {
  constructor(size, workerConfig) {
    this.size = size;
    this.workerConfig = workerConfig;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.stats = { succeeded: 0, failed: 0, skipped: 0, inProgress: 0 };
    this.totalQueued = 0;
    this._resolveAllDone = null;
  }

  async start() {
    console.log(`  Spawning ${this.size} worker threads...\n`);

    const readyPromises = [];

    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: this.workerConfig,
      });

      const id = i + 1;
      worker._id = id;

      const readyP = new Promise((resolve) => {
        const onMsg = (msg) => {
          if (msg.type === 'ready') {
            worker.off('message', onMsg);
            resolve();
          }
        };
        worker.on('message', onMsg);
      });

      worker.on('message', (msg) => this._handleMessage(worker, msg));
      worker.on('error', (err) => this._handleError(worker, err));
      worker.on('exit', (code) => this._handleExit(worker, code));

      this.workers.push(worker);
      readyPromises.push(readyP);
    }

    await Promise.all(readyPromises);
    this.idle = [...this.workers];
    console.log(`  All ${this.size} workers ready.\n`);
  }

  enqueue(novels) {
    this.queue.push(...novels);
    this.totalQueued = this.queue.length;
    this._dispatch();
  }

  waitUntilDone() {
    if (this.stats.inProgress === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this._resolveAllDone = resolve;
    });
  }

  async shutdown() {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'exit' });
    }
    await Promise.allSettled(this.workers.map(w =>
      new Promise((resolve) => w.once('exit', resolve))
    ));
  }

  _dispatch() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.shift();
      const novel = this.queue.shift();
      this.stats.inProgress++;
      worker.postMessage({ type: 'download', slug: novel.slug, title: novel.title });
    }
  }

  _handleMessage(worker, msg) {
    if (msg.type === 'progress') {
      const pct = Math.round((msg.completed / msg.total) * 100);
      const done = this.stats.succeeded + this.stats.failed + this.stats.skipped;
      process.stdout.write(
        `\r  [Worker ${worker._id}] ${msg.title}: ${msg.completed}/${msg.total} chapters (${pct}%)` +
        `  |  Overall: ${done}/${this.totalQueued} novels   `
      );
    } else if (msg.type === 'result') {
      this.stats.inProgress--;

      if (msg.success) {
        this.stats.succeeded++;
        const failInfo = msg.failedChapters > 0 ? ` (${msg.failedChapters} chapters failed)` : '';
        console.log(`\n  ✓ [Worker ${worker._id}] ${msg.title} — ${msg.totalChapters} chapters${failInfo}`);
      } else if (msg.skipped) {
        this.stats.skipped++;
        console.log(`\n  ⊘ [Worker ${worker._id}] ${msg.slug} — skipped: ${msg.error}`);
      } else {
        this.stats.failed++;
        console.log(`\n  ✗ [Worker ${worker._id}] ${msg.slug} — ${msg.error}`);
      }

      this.idle.push(worker);
      this._dispatch();
      this._checkDone();
    }
  }

  _handleError(worker, err) {
    console.error(`\n  Worker ${worker._id} error: ${err.message}`);
    this.stats.inProgress--;
    this.stats.failed++;

    // Respawn worker
    const idx = this.workers.indexOf(worker);
    if (idx !== -1) {
      const newWorker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: this.workerConfig,
      });
      newWorker._id = worker._id;
      newWorker.on('message', (msg) => this._handleMessage(newWorker, msg));
      newWorker.on('error', (err) => this._handleError(newWorker, err));
      newWorker.on('exit', (code) => this._handleExit(newWorker, code));

      this.workers[idx] = newWorker;

      const readyP = new Promise((resolve) => {
        const onMsg = (msg) => {
          if (msg.type === 'ready') {
            newWorker.off('message', onMsg);
            resolve();
          }
        };
        newWorker.on('message', onMsg);
      });

      readyP.then(() => {
        this.idle.push(newWorker);
        this._dispatch();
        this._checkDone();
      });
    }
  }

  _handleExit(worker, code) {
    if (code !== 0 && code !== null) {
      console.error(`  Worker ${worker._id} exited with code ${code}`);
    }
  }

  _checkDone() {
    if (this.stats.inProgress === 0 && this.queue.length === 0 && this._resolveAllDone) {
      this._resolveAllDone();
      this._resolveAllDone = null;
    }
  }
}

// ── Main ──

async function main() {
  const args = parseCliArgs();

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Worker-Based Novel Crawler`);
  console.log(`  Workers: ${args.workers}  |  Pages: ${args.pages}  |  Concurrency: ${args.concurrency}/worker`);
  console.log(`${'═'.repeat(50)}\n`);

  // Step 1: Crawl listing pages
  const cached = !args.refresh ? loadCachedNovelList() : null;
  let allNovels;

  if (cached) {
    console.log(`Step 1: Using cached novel list (${cached.length} novels). Use --refresh to re-crawl.\n`);
    allNovels = cached;
  } else {
    console.log(`Step 1: Crawling ${args.pages} listing page${args.pages > 1 ? 's' : ''}...\n`);
    allNovels = [];
    for (let p = 1; p <= args.pages; p++) {
      process.stdout.write(`  Page ${p}/${args.pages}...`);
      const novels = await fetchNovelList(p, args.delayMs);
      allNovels.push(...novels);
      console.log(` ${novels.length} novels`);
      if (p < args.pages) await delay(args.delayMs);
    }
    saveCachedNovelList(allNovels);
    console.log(`  Cached to ${NOVEL_LIST_CACHE}\n`);
  }

  console.log(`  Total novels discovered: ${allNovels.length}\n`);

  if (allNovels.length === 0) {
    console.log('No novels found. Exiting.');
    return;
  }

  // Step 2: Filter out already-downloaded novels
  const toDownload = allNovels.filter(n => !epubExists(n.title));
  const alreadyDone = allNovels.length - toDownload.length;

  console.log(`Step 2: ${toDownload.length} novels to download (${alreadyDone} already exist).\n`);

  if (toDownload.length === 0) {
    console.log('All novels already downloaded!');
    return;
  }

  // Step 3: Download using worker pool
  console.log(`Step 3: Downloading with ${args.workers} workers...\n`);

  const pool = new WorkerPool(args.workers, {
    delayMs: args.delayMs,
    concurrency: args.concurrency,
    maxChapters: args.maxChapters,
    outputDir: OUTPUT_DIR,
  });

  await pool.start();
  pool.enqueue(toDownload);
  await pool.waitUntilDone();
  await pool.shutdown();

  // Summary
  const { succeeded, failed, skipped } = pool.stats;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Crawl Complete!`);
  console.log(`  ✓ Succeeded:     ${succeeded}`);
  console.log(`  ⊘ Skipped:       ${skipped + alreadyDone} (${alreadyDone} pre-existing)`);
  console.log(`  ✗ Failed:        ${failed}`);
  console.log(`  Total discovered: ${allNovels.length}`);
  console.log(`${'═'.repeat(50)}\n`);
}

main().catch((err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});
