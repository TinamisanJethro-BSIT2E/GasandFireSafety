require('dotenv').config();

if (!process.env.JWT_SECRET || !process.env.DEVICE_API_KEY) {
  throw new Error('JWT_SECRET and DEVICE_API_KEY must be configured');
}

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { router, authenticateWebSocket } = require('./routes');

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
app.use(cookieParser());
app.use('/api', router);
app.use('/vendor/chart.js', express.static(path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist')));
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
  if (!authenticateWebSocket(request, socket, head)) return;
  wsServer.handleUpgrade(request, socket, head, (websocket) => {
    websocket.authenticated = true;
    websocket.userId = request.wsUser.id;
    wsServer.emit('connection', websocket, request);
  });
});

wsServer.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
});

const port = Number.parseInt(process.env.PORT || '3000', 10);
server.listen(port, () => console.log(`Gas & Fire Safety System listening on http://localhost:${port}`));

function shutdown() {
  server.close(() => {
    wsServer.close();
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
