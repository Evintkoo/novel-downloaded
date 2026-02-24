import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const INPUT_DIR = 'output';
const OUTPUT_DIR = 'docs/epubs';
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');

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

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.epub'));
  if (files.length === 0) {
    console.log('No EPUBs found in output/');
    return;
  }

  const manifest = [];

  for (const file of files) {
    const srcPath = path.join(INPUT_DIR, file);
    const meta = await extractMetadata(srcPath);
    if (!meta) {
      console.log(`  Skipping ${file} — could not read metadata`);
      continue;
    }

    const slug = slugify(meta.title);
    const destFile = `${slug}.epub`;
    const destPath = path.join(OUTPUT_DIR, destFile);
    const stat = fs.statSync(srcPath);

    fs.copyFileSync(srcPath, destPath);

    manifest.push({
      slug,
      file: destFile,
      title: meta.title,
      author: meta.author,
      chapters: meta.chapters,
      size: stat.size,
    });

    console.log(`  ${meta.title} → ${destFile}`);
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written: ${MANIFEST_PATH} (${manifest.length} novels)`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
