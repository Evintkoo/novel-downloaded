import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const DEFAULT_INPUT_DIR = 'output';
const DEFAULT_OUTPUT_DIR = 'docs/epubs';

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function extractMetadata(epubPath) {
  const buf = fs.readFileSync(epubPath);
  const zip = await JSZip.loadAsync(buf);

  // Find the OPF file
  let opfContent = null;
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.opf')) {
      opfContent = await zip.files[name].async('text');
      break;
    }
  }

  if (!opfContent) return null;

  function decodeXml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'");
  }

  const rawTitle = opfContent.match(/<dc:title>(.*?)<\/dc:title>/)?.[1] || path.basename(epubPath, '.epub');
  const rawAuthor = opfContent.match(/<dc:creator[^>]*>(.*?)<\/dc:creator>/)?.[1] || 'Unknown Author';
  const title = decodeXml(rawTitle);
  const author = decodeXml(rawAuthor);

  // Count chapter files (xhtml files excluding toc/nav)
  const chapterFiles = Object.keys(zip.files).filter(
    n => n.endsWith('.xhtml') && !n.includes('toc') && !n.includes('nav')
  );

  return { title, author, chapters: chapterFiles.length };
}

export async function syncLibrary(inputDir = DEFAULT_INPUT_DIR, outputDir = DEFAULT_OUTPUT_DIR) {
  fs.mkdirSync(outputDir, { recursive: true });

  const manifestPath = path.join(outputDir, 'manifest.json');

  // Load existing manifest to merge with
  let existingManifest = [];
  if (fs.existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      existingManifest = [];
    }
  }
  const existingSlugs = new Set(existingManifest.map(e => e.slug));

  const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.epub'));
  if (files.length === 0) {
    console.log('No EPUBs found in ' + inputDir);
    return existingManifest;
  }

  let newCount = 0;

  for (const file of files) {
    const srcPath = path.join(inputDir, file);
    const meta = await extractMetadata(srcPath);
    if (!meta) {
      console.log(`  Skipping ${file} — could not read metadata`);
      continue;
    }

    const slug = slugify(meta.title);

    // Skip if already in manifest
    if (existingSlugs.has(slug)) {
      continue;
    }

    const destFile = `${slug}.epub`;
    const destPath = path.join(outputDir, destFile);
    const stat = fs.statSync(srcPath);

    fs.copyFileSync(srcPath, destPath);

    existingManifest.push({
      slug,
      file: destFile,
      title: meta.title,
      author: meta.author,
      chapters: meta.chapters,
      size: stat.size,
    });
    existingSlugs.add(slug);
    newCount++;

    console.log(`  ${meta.title} → ${destFile}`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(existingManifest, null, 2));
  console.log(`\nManifest written: ${manifestPath} (${existingManifest.length} total, ${newCount} new)`);

  return existingManifest;
}

// Run directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('sync-library.js') ||
  process.argv[1].endsWith('sync-library')
);

if (isMain) {
  syncLibrary().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
