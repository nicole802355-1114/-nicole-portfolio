const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const GITHUB_BASE = 'https://github.com/nicole802355-1114/portfolio-videos/releases/download/v1.0/';
const MAX_REDIRECTS = 5;

// MIME type mapping
const MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

/**
 * Follow HTTP redirects (up to MAX_REDIRECTS) and return the final response.
 * Preserves the original headers (including Range) across all redirects.
 */
function followRedirect(requestUrl, options, redirectCount, callback) {
  if (redirectCount > MAX_REDIRECTS) {
    return callback(new Error('Too many redirects'));
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrl);
  } catch (e) {
    return callback(new Error('Invalid URL: ' + requestUrl));
  }

  const client = parsedUrl.protocol === 'https:' ? https : http;

  const reqOptions = {
    method: options.method || 'GET',
    headers: Object.assign({}, options.headers || {}),
  };

  const req = client.request(parsedUrl, reqOptions, (res) => {
    // Handle redirect (301, 302, 303, 307, 308)
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      // Drain the response body to free the socket
      res.resume();

      // Resolve relative redirects
      const nextUrl = new URL(res.headers.location, requestUrl).href;
      console.log(`Redirect ${res.statusCode} -> ${nextUrl} (step ${redirectCount + 1})`);
      followRedirect(nextUrl, options, redirectCount + 1, callback);
    } else {
      callback(null, res);
    }
  });

  req.on('error', (err) => callback(err));
  req.setTimeout(30000, () => {
    req.destroy(new Error('Request timeout'));
  });
  req.end();
}

/**
 * Handle proxy requests for videos/images from GitHub Releases.
 * Rewrites Content-Type and Content-Disposition so browsers play inline.
 */
function handleVideoProxy(req, res, filename) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('Method Not Allowed');
  }

  const githubUrl = GITHUB_BASE + filename;
  const mimeType = getMimeType(filename);
  const range = req.headers.range;

  // Build headers to forward
  const forwardHeaders = {};
  if (range) {
    forwardHeaders['Range'] = range;
  }

  console.log(`[proxy] ${req.method} ${filename} | Range: ${range || 'none'}`);

  followRedirect(githubUrl, {
    method: req.method,
    headers: forwardHeaders,
  }, 0, (err, proxyRes) => {
    if (err) {
      console.error(`[proxy] Error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway: ' + err.message);
      }
      return;
    }

    // Build response headers
    const responseHeaders = {};

    // Content-Type: always override with correct MIME type
    responseHeaders['Content-Type'] = mimeType;

    // Content-Disposition: inline (play in browser, don't download)
    responseHeaders['Content-Disposition'] = 'inline';

    // Cache for 24 hours
    responseHeaders['Cache-Control'] = 'public, max-age=86400';

    // Forward content-length or content-range
    if (proxyRes.headers['content-range']) {
      responseHeaders['Content-Range'] = proxyRes.headers['content-range'];
    }
    if (proxyRes.headers['content-length']) {
      responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
    }

    // Indicate we accept range requests
    responseHeaders['Accept-Ranges'] = 'bytes';

    const statusCode = proxyRes.statusCode; // 200 or 206

    // HEAD request: just return headers
    if (req.method === 'HEAD') {
      res.writeHead(statusCode, responseHeaders);
      proxyRes.resume(); // drain the response
      return res.end();
    }

    // GET request: stream the response
    res.writeHead(statusCode, responseHeaders);
    proxyRes.pipe(res);

    proxyRes.on('error', (proxyErr) => {
      console.error(`[proxy] Stream error: ${proxyErr.message}`);
      if (!res.writableEnded) {
        res.end();
      }
    });

    req.on('close', () => {
      // Client disconnected, destroy the upstream stream
      proxyRes.destroy();
    });
  });
}

/**
 * Serve static files from the public directory.
 * Supports Range requests for local files.
 */
function serveStatic(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url);
  let pathname = parsedUrl.pathname;

  // Default to index.html for root
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Security: prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }

    const mimeType = getMimeType(filePath);
    const fileSize = stats.size;

    // HEAD request
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      });
      return res.end();
    }

    // Handle Range requests for static files
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || isNaN(end) || start >= fileSize || start < 0) {
        res.writeHead(416, {
          'Content-Range': 'bytes */' + fileSize,
        });
        return res.end();
      }

      const clampedEnd = Math.min(end, fileSize - 1);
      const chunkSize = clampedEnd - start + 1;

      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + clampedEnd + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });

      fs.createReadStream(filePath, { start: start, end: clampedEnd }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

// ============ Main Server ============
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  // Video/image proxy: /videos/*
  if (pathname.startsWith('/videos/')) {
    const filename = decodeURIComponent(pathname.slice('/videos/'.length));
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad Request');
    }
    return handleVideoProxy(req, res, filename);
  }

  // Static files from /public
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Nicole Portfolio server running on port ${PORT}`);
  console.log(`Serving static files from: ${PUBLIC_DIR}`);
  console.log(`Video proxy: /videos/* -> GitHub Releases`);
});
