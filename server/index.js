require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

if (!process.env.DEVICE_API_KEY) {
  throw new Error('DEVICE_API_KEY must be configured');
}

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { router } = require('./routes');

const app = express();
const server = http.createServer(app);
const wsServer = new WebSocketServer({ noServer: true });
app.set('wsServer', wsServer);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      fontSrc: ["'self'", 'data:']
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', router);
app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
app.get(['/', '/index.html', '/settings.html', '/users.html'], (req, res) => {
  res.redirect('/dashboard.html');
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((error, req, res, next) => {
  console.error('Request failed:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/live') {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(request, socket, head, (websocket) => {
    wsServer.emit('connection', websocket, request);
  });
});

wsServer.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
db.initialize().then(() => {
  server.listen(port, () => console.log(`Gas & Fire Safety System listening on http://localhost:${port}`));
}).catch((error) => {
  console.error('Database initialization failed:', error);
  process.exitCode = 1;
  db.close().finally(() => process.exit());
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    wsServer.close();
    db.close().then(() => process.exit(0)).catch((error) => {
      console.error('Database shutdown failed:', error.message);
      process.exit(1);
    });
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
