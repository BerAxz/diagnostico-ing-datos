const express = require('express');
const http    = require('http');
const path    = require('path');
const { Server }       = require('socket.io');
const { createClient } = require('redis');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const PORT          = process.env.PORT          || 3000;
const REDIS_HOST    = process.env.REDIS_HOST    || 'localhost';
const REDIS_PORT    = process.env.REDIS_PORT    || '6379';
const REDIS_CHANNEL = process.env.REDIS_CHANNEL || 'miner_words';
const TOP_N_DEFAULT = Number(process.env.TOP_N  || 20);

// ─────────────────────────────────────────────
// HTTP + Socket.IO
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Counters (in-memory)
// ─────────────────────────────────────────────
const counters = {
  total:  new Map(),
  python: new Map(),
  java:   new Map(),
};

function incrementCounter(map, word) {
  map.set(word, (map.get(word) || 0) + 1);
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
    total:  toTopArray(counters.total,  topN),
    python: toTopArray(counters.python, topN),
    java:   toTopArray(counters.java,   topN),
  };
}

// ─────────────────────────────────────────────
// Per-socket topN tracking  ← fix principal
// ─────────────────────────────────────────────
// Guardamos el topN de cada socket conectado para que,
// cuando llega un mensaje de Redis, cada cliente reciba
// el ranking con SU propio límite configurado.
const socketTopN = new Map(); // socket.id → topN

io.on('connection', (socket) => {
  // Usar el topN que llegó en query como valor inicial,
  // o el default si no viene / es inválido.
  const initialTopN = parseTopN(socket.handshake.query.topN);
  socketTopN.set(socket.id, initialTopN);

  // Enviar el estado actual al cliente que se acaba de conectar
  socket.emit('ranking:update', getRanking(initialTopN));

  // El cliente cambia su topN
  socket.on('ranking:setTopN', (value) => {
    const topN = parseTopN(value);
    socketTopN.set(socket.id, topN);
    socket.emit('ranking:update', getRanking(topN));
  });

  // Limpiar al desconectarse
  socket.on('disconnect', () => {
    socketTopN.delete(socket.id);
  });
});

/** Parsea y valida un valor topN; devuelve TOP_N_DEFAULT si es inválido. */
function parseTopN(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TOP_N_DEFAULT;
}

/** Emite el ranking a cada socket con su propio topN. */
function broadcastRanking() {
  for (const [id, topN] of socketTopN.entries()) {
    const socket = io.sockets.sockets.get(id);
    if (socket) {
      socket.emit('ranking:update', getRanking(topN));
    }
  }
}

// ─────────────────────────────────────────────
// Redis consumer con reconexión automática
// ─────────────────────────────────────────────
async function startRedisConsumer() {
  const redisUrl = `redis://${REDIS_HOST}:${REDIS_PORT}`;

  const client = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        // Espera progresiva: 500ms, 1s, 2s… hasta 10s máximo
        const delay = Math.min(500 * 2 ** retries, 10_000);
        console.log(`Redis: reintentando conexión en ${delay}ms (intento ${retries + 1})…`);
        return delay;
      },
    },
  });

  client.on('error',    (err) => console.error('Redis error:',       err.message));
  client.on('reconnecting', () => console.log ('Redis: reconectando…'));
  client.on('ready',    ()    => console.log ('Redis: conectado.'));

  // Si Redis no está disponible al arrancar, el servidor sigue corriendo
  // y reintenta automáticamente (reconnectStrategy).
  try {
    await client.connect();
  } catch (err) {
    console.error('Redis: conexión inicial fallida —', err.message);
    console.error('El servidor continuará intentando reconectarse.');
  }

  // Necesitamos un cliente separado para subscribe (redis/node-redis v4+
  // no permite usar el mismo cliente para pub/sub y comandos regulares).
  const subscriber = client.duplicate();
  subscriber.on('error', (err) => console.error('Redis subscriber error:', err.message));

  try {
    await subscriber.connect();
  } catch (err) {
    console.error('Redis subscriber: conexión fallida —', err.message);
  }

  await subscriber.subscribe(REDIS_CHANNEL, (message) => {
    try {
      const payload  = JSON.parse(message);
      const word     = String(payload.word     || '').trim().toLowerCase();
      const language = String(payload.language || '').trim().toLowerCase();

      if (!word) return;

      incrementCounter(counters.total, word);
      if (language === 'python') incrementCounter(counters.python, word);
      else if (language === 'java') incrementCounter(counters.java, word);

      // Emitir a cada cliente con su topN individual ← fix principal
      broadcastRanking();
    } catch (err) {
      console.error('Mensaje inválido de Redis:', err.message);
    }
  });

  console.log(`Suscrito al canal Redis '${REDIS_CHANNEL}'`);
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Visualizer corriendo en http://localhost:${PORT}`);
});

startRedisConsumer().catch((err) => {
  console.error('Error fatal iniciando Redis consumer:', err.message);
  process.exit(1);
});