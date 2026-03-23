const topNInput = document.getElementById('topN');
const applyButton = document.getElementById('applyTopN');

const socket = io({
  query: { topN: topNInput.value || '20' },
});

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
  return Array.from({ length: size }, (_, idx) => COLOR_PALETTE[idx % COLOR_PALETTE.length]);
}

function createChart(canvasId) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [],
      datasets: [
        {
          label: 'Cantidad',
          data: [],
          backgroundColor: [],
          borderColor: '#ffffff',
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: false,
        },
      },
    },
  });
}

const totalChart = createChart('totalChart');
const pythonChart = createChart('pythonChart');
const javaChart = createChart('javaChart');

const totalLegend = document.getElementById('totalLegend');
const pythonLegend = document.getElementById('pythonLegend');
const javaLegend = document.getElementById('javaLegend');

function renderLegend(container, labels, colors, values) {
  const rows = labels.map((label, idx) => {
    const color = colors[idx] || 'rgba(107, 114, 128, 0.75)';
    const value = values[idx] || 0;
    return `<div class="legend-item"><span class="legend-color" style="background:${color}"></span><span>${label}: ${value}</span></div>`;
  });
  container.innerHTML = rows.join('');
}

function updateChart(chart, legendContainer, items) {
  const labels = items.map((item) => item.word);
  const values = items.map((item) => item.count);
  const colors = buildColors(items.length);

  chart.data.labels = labels;
  chart.data.datasets[0].data = values;
  chart.data.datasets[0].backgroundColor = colors;
  chart.update();
  renderLegend(legendContainer, labels, colors, values);
}

socket.on('ranking:update', (payload) => {
  updateChart(totalChart, totalLegend, payload.total || []);
  updateChart(pythonChart, pythonLegend, payload.python || []);
  updateChart(javaChart, javaLegend, payload.java || []);
});

applyButton.addEventListener('click', () => {
  const value = Number(topNInput.value);
  const topN = Number.isFinite(value) && value > 0 ? value : 20;
  socket.emit('ranking:setTopN', topN);
});
