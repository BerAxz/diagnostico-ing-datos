// ─────────────────────────────────────────────
// DOM references
// ─────────────────────────────────────────────
const topNInput   = document.getElementById('topN');
const applyButton = document.getElementById('applyTopN');
const statusBadge = document.getElementById('statusBadge');

// ─────────────────────────────────────────────
// Socket.IO  (sin pasar topN en query — lo
// enviamos como evento una vez conectados)
// ─────────────────────────────────────────────
const socket = io({ reconnectionDelay: 2000, reconnectionAttempts: Infinity });

socket.on('connect', () => {
  setStatus('connected', 'Conectado');
  // Al (re)conectar, le enviamos el topN actual para que el servidor
  // devuelva el ranking correcto desde el primer mensaje.
  emitTopN();
});

socket.on('disconnect', () => setStatus('disconnected', 'Desconectado'));
socket.on('connect_error', () => setStatus('disconnected', 'Error de conexión'));

// ─────────────────────────────────────────────
// Status badge helper
// ─────────────────────────────────────────────
function setStatus(state, text) {
  statusBadge.textContent = text;
  statusBadge.className = state; // 'connected' | 'disconnected' | ''
}

// ─────────────────────────────────────────────
// Colores
// ─────────────────────────────────────────────
const COLOR_PALETTE = [
  'rgba(59, 130, 246, 0.75)',
  'rgba(16, 185, 129, 0.75)',
  'rgba(249, 115, 22, 0.75)',
  'rgba(244, 63, 94, 0.75)',
  'rgba(139, 92, 246, 0.75)',
  'rgba(234, 179, 8, 0.75)',
  'rgba(20, 184, 166, 0.75)',
  'rgba(236, 72, 153, 0.75)',
  'rgba(99, 102, 241, 0.75)',
  'rgba(245, 158, 11, 0.75)',
];

function buildColors(size) {
  return Array.from({ length: size }, (_, i) => COLOR_PALETTE[i % COLOR_PALETTE.length]);
}

// ─────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────
function createChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [],
      datasets: [{
        label: 'Cantidad',
        data: [],
        backgroundColor: [],
        borderColor: '#ffffff',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
    },
  });
}

const charts = {
  total:  createChart('totalChart'),
  python: createChart('pythonChart'),
  java:   createChart('javaChart'),
};

const legends = {
  total:  document.getElementById('totalLegend'),
  python: document.getElementById('pythonLegend'),
  java:   document.getElementById('javaLegend'),
};

const empties = {
  total:  document.getElementById('totalEmpty'),
  python: document.getElementById('pythonEmpty'),
  java:   document.getElementById('javaEmpty'),
};

// ─────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────
function renderLegend(container, labels, colors, values) {
  container.innerHTML = labels
    .map((label, i) => {
      const color = colors[i] || 'rgba(107,114,128,0.75)';
      return `<div class="legend-item">
        <span class="legend-color" style="background:${color}"></span>
        <span>${label}: ${values[i] ?? 0}</span>
      </div>`;
    })
    .join('');
}

function updateChart(key, items) {
  const chart  = charts[key];
  const legend = legends[key];
  const empty  = empties[key];

  const hasData = items && items.length > 0;
  empty.style.display = hasData ? 'none' : 'flex';

  if (!hasData) {
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.data.datasets[0].backgroundColor = [];
    chart.update();
    legend.innerHTML = '';
    return;
  }

  const labels = items.map((item) => item.word);
  const values = items.map((item) => item.count);
  const colors = buildColors(items.length);

  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  chart.data.datasets[0].backgroundColor = colors;
  chart.update();
  renderLegend(legend, labels, colors, values);
}

// ─────────────────────────────────────────────
// Incoming ranking updates
// ─────────────────────────────────────────────
socket.on('ranking:update', (payload) => {
  updateChart('total',  payload.total  || []);
  updateChart('python', payload.python || []);
  updateChart('java',   payload.java   || []);
});

// ─────────────────────────────────────────────
// Top-N control
// ─────────────────────────────────────────────
function getTopN() {
  const value = Number(topNInput.value);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 20;
}

function emitTopN() {
  socket.emit('ranking:setTopN', getTopN());
}

applyButton.addEventListener('click', () => {
  // Validación básica antes de enviar
  const n = getTopN();
  topNInput.value = n;           // normaliza el valor en el input
  applyButton.disabled = true;
  socket.emit('ranking:setTopN', n);
  // Re-habilitar el botón tras un breve instante
  setTimeout(() => { applyButton.disabled = false; }, 500);
});

// Enviar también al presionar Enter dentro del input
topNInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyButton.click();
});