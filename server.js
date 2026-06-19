#!/usr/bin/env node

const http = require('http');
const url = require('url');

console.log('[TEST] Starting minimal HTTP server');

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  console.log('[TEST] Request:', req.method, pathname);
  
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from intractmd\n');
});

server.listen(3000, '0.0.0.0', () => {
  console.log('[TEST] Server listening on 0.0.0.0:3000');
});

server.on('error', (err) => {
  console.error('[TEST] Server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[TEST] SIGTERM received');
  server.close(() => process.exit(0));
});

// Keep alive
setInterval(() => {}, 30000);

