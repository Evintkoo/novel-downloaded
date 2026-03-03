import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { URL } from 'node:url';

const TARGET_HOST = 'freewebnovel.com';
const BYPASS_IP = '104.21.234.247';
const MAX_REDIRECTS = 5;
const RESPONSE_TIMEOUT = 60000; // 60s for full response body

// On CI (GitHub Actions), skip DNS bypass — normal DNS works and the
// hardcoded IP triggers Cloudflare 403. Only use bypass locally where
// the domain may be DNS-blocked.
const USE_DNS_BYPASS = !process.env.CI;

function decompressStream(res) {
  const encoding = (res.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip') return res.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return res.pipe(zlib.createInflate());
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

const customLookup = (hostname, options, callback) => {
  // Handle both (hostname, options, cb) and (hostname, cb) signatures
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (USE_DNS_BYPASS && (hostname === TARGET_HOST || hostname === `www.${TARGET_HOST}`)) {
    if (options.all) {
      callback(null, [{ address: BYPASS_IP, family: 4 }]);
    } else {
      callback(null, BYPASS_IP, 4);
    }
  } else {
    dns.lookup(hostname, options, callback);
  }
};

export function fetchWithBypassRaw(url, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`));
      return;
    }

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const req = mod.request(url, {
      lookup: customLookup,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    }, (res) => {
      // Handle redirects — drain the response body first to free the socket
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain body to release socket
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchWithBypassRaw(redirectUrl, _redirectCount + 1).then(resolve).catch(fail);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // drain body to release socket
        fail(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      // Set a timeout for receiving the full response body
      const bodyTimer = setTimeout(() => {
        req.destroy();
        fail(new Error(`Response body timeout for ${url}`));
      }, RESPONSE_TIMEOUT);

      const stream = decompressStream(res);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        clearTimeout(bodyTimer);
        if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf-8')); }
      });
      stream.on('error', (err) => { clearTimeout(bodyTimer); fail(err); });
    });

    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error(`Timeout for ${url}`)); });
    req.on('socket', (socket) => {
      if (!socket._hasFailListener) {
        socket._hasFailListener = true;
        socket.on('error', (err) => { fail(err); });
      }
    });
    req.end();
  });
}

export function fetchBufferWithBypass(url, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`));
      return;
    }

    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const req = mod.request(url, {
      lookup: customLookup,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    }, (res) => {
      // Handle redirects — drain the response body first to free the socket
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain body to release socket
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchBufferWithBypass(redirectUrl, _redirectCount + 1).then(resolve).catch(fail);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume(); // drain body to release socket
        fail(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      // Set a timeout for receiving the full response body
      const bodyTimer = setTimeout(() => {
        req.destroy();
        fail(new Error(`Response body timeout for ${url}`));
      }, RESPONSE_TIMEOUT);

      const stream = decompressStream(res);
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        clearTimeout(bodyTimer);
        if (!settled) { settled = true; resolve(Buffer.concat(chunks)); }
      });
      stream.on('error', (err) => { clearTimeout(bodyTimer); fail(err); });
    });

    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error(`Timeout for ${url}`)); });
    req.on('socket', (socket) => {
      if (!socket._hasFailListener) {
        socket._hasFailListener = true;
        socket.on('error', (err) => { fail(err); });
      }
    });
    req.end();
  });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry(fn, retries = 5, delayMs = 3000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      const is429 = err.message.includes('429');
      const MAX_BACKOFF = 30000;
      const backoff = Math.min(
        is429
          ? delayMs * Math.pow(2, i) // Exponential backoff for rate limits
          : delayMs * (i + 1),
        MAX_BACKOFF
      );
      if (is429 && i === 0) {
        // Only log once for 429s to reduce noise
        console.error(`  Rate limited, backing off...`);
      } else if (!is429) {
        console.error(`  Retry ${i + 1}/${retries}: ${err.message}`);
      }
      await delay(backoff);
    }
  }
}

export function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
