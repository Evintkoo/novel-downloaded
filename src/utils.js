import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import { URL } from 'node:url';
import path from 'node:path';

const TARGET_HOST = 'freewebnovel.com';
const BYPASS_IP = '104.21.234.247';

const customLookup = (hostname, options, callback) => {
  // Handle both (hostname, options, cb) and (hostname, cb) signatures
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname === TARGET_HOST || hostname === `www.${TARGET_HOST}`) {
    if (options.all) {
      callback(null, [{ address: BYPASS_IP, family: 4 }]);
    } else {
      callback(null, BYPASS_IP, 4);
    }
  } else {
    dns.lookup(hostname, options, callback);
  }
};

const httpsAgent = new https.Agent({ lookup: customLookup });
const httpAgent = new http.Agent({ lookup: customLookup });

export async function fetchWithBypass(url) {
  const parsed = new URL(url);
  const agent = parsed.protocol === 'https:' ? httpsAgent : httpAgent;

  const res = await fetch(url, {
    agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    dispatcher: undefined,
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.text();
}

// Node's built-in fetch doesn't support the `agent` option.
// We use undici's custom dispatcher or fallback to node:https manually.
// Let's implement a proper fetch using node:https for DNS bypass.
export function fetchWithBypassRaw(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const req = mod.request(url, {
      lookup: customLookup,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchWithBypassRaw(redirectUrl).then(resolve).catch(fail);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        fail(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf-8')); } });
      res.on('error', fail);
    });

    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error(`Timeout for ${url}`)); });
    req.on('socket', (socket) => { if (!socket.listenerCount('error')) socket.on('error', fail); });
    req.end();
  });
}

export function fetchBufferWithBypass(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    const req = mod.request(url, {
      lookup: customLookup,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchBufferWithBypass(redirectUrl).then(resolve).catch(fail);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        fail(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
      res.on('error', fail);
    });

    req.on('error', fail);
    req.on('timeout', () => { req.destroy(); fail(new Error(`Timeout for ${url}`)); });
    req.on('socket', (socket) => { socket.on('error', fail); });
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
      const backoff = is429
        ? delayMs * Math.pow(2, i) // Exponential backoff for rate limits
        : delayMs * (i + 1);
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
