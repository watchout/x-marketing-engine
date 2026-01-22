#!/usr/bin/env node
/**
 * シンプルなローカルサーバー
 * ダッシュボード表示用
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3333;
const ROOT = __dirname;

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.yml': 'text/yaml',
};

const server = http.createServer((req, res) => {
  let filePath = path.join(ROOT, req.url === '/' ? '/dashboard/index.html' : req.url);
  
  // セキュリティ: ルート外へのアクセスを防止
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404);
        res.end('Not Found: ' + req.url);
      } else {
        res.writeHead(500);
        res.end('Server Error');
      }
      return;
    }
    
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  X Marketing Engine Dashboard                ║
║  http://localhost:${PORT}                       ║
╚══════════════════════════════════════════════╝

Ctrl+C で終了
`);
});
