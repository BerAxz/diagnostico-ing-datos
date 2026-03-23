const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_CHANNEL = process.env.REDIS_CHANNEL || 'miner_words';
const TOP_N_DEFAULT = Number(process.env.TOP_N || 20);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const counters = {
  total: new Map(),
  python: new Map(),
  java: new Map(),
};

function incrementCounter(map, word) {
  const current = map.get(word) || 0;
  map.set(word, current + 1);
}

function toTopArray(map, topN) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({ word, count }));
}

function getRanking(topN) {
  return {
    topN,
    total: toTopArray(counters.total, topN),
    python: toTopArray(counters.python, topN),
    java: toTopArray(counters.java, topN),
  };
}

function emitRanking(topN) {
  io.emit('ranking:update', getRanking(topN));
}

io.on('connection', (socket) => {
  const topN = Number(socket.handshake.query.topN || TOP_N_DEFAULT);
  socket.emit('ranking:update', getRanking(topN));

  socket.on('ranking:setTopN', (value) => {
    const parsed = Number(value);
    const topNValue = Number.isFinite(parsed) && parsed > 0 ? parsed : TOP_N_DEFAULT;
    socket.emit('ranking:update', getRanking(topNValue));
  });
});

async function startRedisConsumer() {
  const redisUrl = `redis://${REDIS_HOST}:${REDIS_PORT}`;
  const client = createClient({ url: redisUrl });

  client.on('error', (err) => {
    console.error('Redis client error:', err.message);
  });

  await client.connect();
  console.log(`Connected to Redis at ${REDIS_HOST}:${REDIS_PORT}`);
  await client.subscribe(REDIS_CHANNEL, (message) => {
    try {
      const payload = JSON.parse(message);
      const word = String(payload.word || '').trim().toLowerCase();
      const language = String(payload.language || '').trim().toLowerCase();

      if (!word) {
        return;
      }

      incrementCounter(counters.total, word);
      if (language === 'python') {
        incrementCounter(counters.python, word);
      } else if (language === 'java') {
        incrementCounter(counters.java, word);
      }

      emitRanking(TOP_N_DEFAULT);
    } catch (err) {
      console.error('Invalid message from Redis:', err.message);
    }
  });

  console.log(`Subscribed to Redis channel '${REDIS_CHANNEL}'`);
}

server.listen(PORT, () => {
  console.log(`Visualizer running on http://localhost:${PORT}`);
});

startRedisConsumer().catch((err) => {
  console.error('Failed to start Redis consumer:', err.message);
  process.exit(1);
});
