// Fixture app: serves message.txt; /health for the runner's checks.
const http = require('http');
const fs = require('fs');
const path = require('path');

http.createServer((req, res) => {
  if (req.url === '/health') return res.end('ok');
  res.end(fs.readFileSync(path.join(__dirname, 'message.txt'), 'utf8'));
}).listen(Number(process.env.PORT), '127.0.0.1');
