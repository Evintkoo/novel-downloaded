import * as cheerio from 'cheerio';
import { fetchWithBypassRaw, fetchBufferWithBypass, delay, retry } from './utils.js';

const BASE_URL = 'https://freewebnovel.com';

export async function fetchNovelList(page = 1, requestDelay = 1000) {
  const url = page === 1
    ? `${BASE_URL}/sort/completed-novel`
    : `${BASE_URL}/sort/completed-novel/${page}`;

  const html = await retry(() => fetchWithBypassRaw(url));
  const $ = cheerio.load(html);

  const novels = [];

  $('div.li-row').each((_, row) => {
    const $row = $(row);
    const $title = $row.find('h3.tit a');
    const title = $title.text().trim();
    const href = $title.attr('href') || '';
    const slug = href.replace('/novel/', '').replace(/\/$/, '');

    const coverUrl = $row.find('div.pic img').attr('src') || '';

    const genres = [];
    // Genres are typically in the description area
    $row.find('div.desc div.item').eq(1).find('a').each((_, a) => {
      genres.push($(a).text().trim());
    });

    const chapterText = $row.find('span.s1').text().trim();
    const chapterMatch = chapterText.match(/(\d+)/);
    const chapterCount = chapterMatch ? parseInt(chapterMatch[1], 10) : 0;

    if (title && slug) {
      novels.push({ title, slug, coverUrl, genres, chapterCount });
    }
  });

  return novels;
}

export async function fetchNovelDetail(slug) {
  const url = `${BASE_URL}/novel/${slug}`;
  const html = await retry(() => fetchWithBypassRaw(url));
  const $ = cheerio.load(html);

  const title = $('h1.tit').text().trim() || $('div.m-imgtxt h1').text().trim();

  // Author from detail page
  const author = $('div.m-imgtxt div.txt div.item').first().find('.right a').text().trim()
    || $('div.m-imgtxt div.txt div.item').first().find('.right').text().trim();

  // Genres
  const genres = [];
  $('div.m-imgtxt div.txt div.item').eq(1).find('.right a').each((_, a) => {
    genres.push($(a).text().trim());
  });

  // Description from meta tag
  const description = $('meta[name="description"]').attr('content') || '';

  // Cover image
  const coverUrl = $('div.m-imgtxt div.pic img').attr('src') || '';

  // Chapter list
  const chapters = [];
  $('ul#idData li a').each((_, a) => {
    const $a = $(a);
    const chTitle = $a.attr('title') || $a.text().trim();
    const chHref = $a.attr('href') || '';
    if (chHref) {
      chapters.push({
        title: chTitle,
        url: chHref.startsWith('http') ? chHref : `${BASE_URL}${chHref}`,
      });
    }
  });

  return { title, author, genres, description, coverUrl, chapters };
}

export async function fetchChapterContent(url) {
  const html = await retry(() => fetchWithBypassRaw(url));
  const $ = cheerio.load(html);

  const article = $('div#article');
  const chapterTitle = article.find('h4').first().text().trim()
    || $('h1.tit').text().trim()
    || '';

  // Remove script tags and ads
  article.find('script, .ads, .ad, ins, .google-auto-placed').remove();

  // Get content paragraphs
  const paragraphs = [];
  article.find('p').each((_, p) => {
    const text = $(p).text().trim();
    if (text) {
      paragraphs.push(`<p>${text}</p>`);
    }
  });

  const content = paragraphs.join('\n');

  return { title: chapterTitle, content };
}

export async function fetchCoverImage(coverUrl) {
  if (!coverUrl) return null;
  try {
    let url;
    if (coverUrl.startsWith('http')) {
      url = coverUrl;
    } else if (coverUrl.startsWith('//')) {
      url = `https:${coverUrl}`;
    } else {
      url = `${BASE_URL}${coverUrl.startsWith('/') ? '' : '/'}${coverUrl}`;
    }
    return await fetchBufferWithBypass(url);
  } catch (err) {
    console.error(`  Failed to fetch cover image: ${err.message}`);
    return null;
  }
}
