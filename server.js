require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createObjectCsvWriter } = require('csv-writer');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_DIR = path.join(__dirname, 'output');
const MASTER_FILE = path.join(DATA_DIR, 'master_orders.json');
const JOB_FILE = path.join(DATA_DIR, 'current_job.json');

const RATE_LIMIT_RETRIES = [10000, 30000, 60000, 120000, 300000];
const CHUNK_DAYS = 3;
const PAGE_LIMIT = 100;

const SHIPROCKET_BASE_URL = process.env.SHIPROCKET_BASE_URL || 'https://apiv2.shiprocket.in';
const ORDERS_ENDPOINT = process.env.SHIPROCKET_ORDERS_ENDPOINT || '/v1/external/orders';

let authToken = null;
let currentJob = null;
let abortController = null;

function ensureDirs() {
  for (const dir of [DATA_DIR, OUTPUT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON(filepath, fallback = null) {
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) { /* ignore */ }
  return fallback;
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

function loadMaster() {
  return readJSON(MASTER_FILE, {});
}

function saveMaster(master) {
  writeJSON(MASTER_FILE, master);
}

function loadJob() {
  return readJSON(JOB_FILE, null);
}

function saveJob(job) {
  writeJSON(JOB_FILE, job);
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function generateChunks(days) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - (days - 1));

  const chunks = [];
  let chunkStart = new Date(from);

  while (chunkStart <= today) {
    let chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + CHUNK_DAYS - 1);
    if (chunkEnd > today) chunkEnd = new Date(today);
    chunks.push({
      index: chunks.length + 1,
      from: formatDate(chunkStart),
      to: formatDate(chunkEnd),
    });
    chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  return chunks;
}

function generateKey(order) {
  if (order.awb_code && order.awb_code !== '') return `awb:${order.awb_code}`;
  if (order.shipment_id && order.shipment_id !== '') return `shipment:${order.shipment_id}`;
  if (order.id) return `shiprocket_order:${order.id}`;
  if (order.order_id && order.order_id !== '') return `channel_order:${order.order_id}`;
  return `shiprocket_order:${order.id || 'unknown'}`;
}

function flattenOrder(order) {
  const products = order.products || [];
  const productsStr = Array.isArray(products)
    ? products.map(p => `${p.name || ''} x${p.quantity || 1}`).join('; ')
    : '';

  return {
    'Shiprocket Unique Key': generateKey(order),
    'Shiprocket Order ID': order.id || '',
    'Channel Order ID': order.order_id || '',
    'Order Date': order.order_date || '',
    'Created At': order.created_at || '',
    'Customer Name': order.billing_customer_name || '',
    'Customer Email': order.billing_email || '',
    'Customer Phone': order.billing_phone || '',
    'Pickup Location': order.pickup_location || '',
    'Payment Status': order.payment_status || '',
    'Payment Method': order.payment_method || '',
    'Order Total': order.total !== undefined ? order.total : (order.order_total || ''),
    'Tax': order.tax || '',
    'Order Status': order.order_status || '',
    'Order Status Code': order.order_status_code !== undefined ? order.order_status_code : '',
    'Shipment ID': order.shipment_id || '',
    'AWB Code': order.awb_code || '',
    'Courier': order.courier_name || '',
    'Current Shipment Status': order.current_status || '',
    'Current Shipment Status ID': order.current_status_id !== undefined ? order.current_status_id : '',
    'Current Shipment Status Time': order.current_status_time || '',
    'Tracking URL': order.tracking_url || '',
    'Expected Delivery Date': order.expected_delivery_date || '',
    'Delivered Date': order.delivered_date || '',
    'Products': productsStr,
    'Last Local API Sync At': new Date().toISOString(),
    'Raw Shiprocket JSON': JSON.stringify(order),
  };
}

async function shiprocketLogin() {
  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;

  if (!email || !password) {
    throw new Error('SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD must be set in .env');
  }

  const res = await axios.post(`${SHIPROCKET_BASE_URL}/v1/external/auth/login`, {
    email,
    password,
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 30000,
  });

  if (!res.data || !res.data.token) {
    throw new Error('Shiprocket login failed: no token received');
  }

  authToken = res.data.token;
  return authToken;
}

async function ensureToken() {
  if (authToken) return authToken;
  return await shiprocketLogin();
}

async function fetchOrdersPage(fromDate, toDate, page) {
  await ensureToken();

  const url = `${SHIPROCKET_BASE_URL}${ORDERS_ENDPOINT}`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    },
    params: {
      from_date: fromDate,
      to_date: toDate,
      page,
      per_page: PAGE_LIMIT,
      limit: PAGE_LIMIT,
    },
    timeout: 30000,
  });

  return res.data;
}

function formatTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s}s`;
}

async function fetchWithRetry(fromDate, toDate, page) {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES.length; attempt++) {
    if (abortController && abortController.aborted) {
      throw new Error('Job aborted');
    }

    try {
      const data = await fetchOrdersPage(fromDate, toDate, page);

      if (currentJob) {
        currentJob.totalFetchedRows = (currentJob.totalFetchedRows || 0) + (data.data ? data.data.length : 0);
      }

      return data;
    } catch (err) {
      const isRateLimit = err.response && err.response.status === 429;
      const retryAfter = err.response && err.response.headers
        ? parseInt(err.response.headers['retry-after'], 10) : null;

      if (isRateLimit && attempt < RATE_LIMIT_RETRIES.length) {
        let waitMs = retryAfter ? retryAfter * 1000 : RATE_LIMIT_RETRIES[attempt];
        if (currentJob) {
          currentJob.lastError = `Rate limited (429). Retry ${attempt + 1}/${RATE_LIMIT_RETRIES.length} after ${formatTime(waitMs)}`;
          saveJob(currentJob);
        }
        await sleep(waitMs);
        continue;
      }

      if (err.response && err.response.status === 401) {
        authToken = null;
        try {
          await shiprocketLogin();
          const data = await fetchOrdersPage(fromDate, toDate, page);
          if (currentJob) {
            currentJob.totalFetchedRows = (currentJob.totalFetchedRows || 0) + (data.data ? data.data.length : 0);
          }
          return data;
        } catch (loginErr) {
          throw loginErr;
        }
      }

      throw err;
    }
  }
  throw new Error(`Failed after ${RATE_LIMIT_RETRIES.length} retries due to rate limit`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runJob(days) {
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - (days - 1));

  const rangeLabel = days === 1 ? 'today'
    : days === 3 ? 'last_3_days'
    : days === 7 ? 'last_7_days'
    : days === 28 ? 'last_28_days'
    : 'last_90_days';

  const chunks = generateChunks(days);

  currentJob = {
    status: 'running',
    rangeLabel,
    totalChunks: chunks.length,
    completedChunks: 0,
    remainingChunks: chunks.length,
    currentChunk: null,
    totalFetchedRows: 0,
    totalUniqueRows: 0,
    lastError: null,
    outputFile: `output/shiprocket_orders_latest.csv`,
  };

  saveJob(currentJob);

  const master = loadMaster();

  try {
    for (const chunk of chunks) {
      if (abortController && abortController.aborted) {
        currentJob.status = 'aborted';
        currentJob.lastError = 'Job was aborted by user';
        saveJob(currentJob);
        currentJob = null;
        return;
      }

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        currentJob.currentChunk = {
          index: chunk.index,
          from: chunk.from,
          to: chunk.to,
          page,
        };
        saveJob(currentJob);

        let data;
        try {
          data = await fetchWithRetry(chunk.from, chunk.to, page);
        } catch (err) {
          console.error(`Chunk ${chunk.index} page ${page} failed: ${err.message}`);
          currentJob.lastError = `Chunk ${chunk.index} page ${page}: ${err.message}`;
          currentJob.status = 'failed';
          saveJob(currentJob);
          currentJob = null;
          return;
        }

        const orders = data.data || data.orders || data || [];
        const orderList = Array.isArray(orders) ? orders : [];

        if (orderList.length === 0) {
          hasMore = false;
        } else {
          for (const order of orderList) {
            const key = generateKey(order);
            const flattened = flattenOrder(order);
            master[key] = flattened;
          }

          currentJob.totalUniqueRows = Object.keys(master).length;
          saveJob(currentJob);

          if (orderList.length < PAGE_LIMIT) {
            hasMore = false;
          } else {
            page++;
            await sleep(1000);
          }
        }
      }

      currentJob.completedChunks++;
      currentJob.remainingChunks = currentJob.totalChunks - currentJob.completedChunks;
      currentJob.currentChunk = null;
      saveJob(currentJob);
      saveMaster(master);

      await sleep(3000);
    }

    const dateStr = formatDate(new Date());
    const csvPath = path.join(OUTPUT_DIR, 'shiprocket_orders_latest.csv');
    const datedCsvPath = path.join(OUTPUT_DIR, `shiprocket_orders_${rangeLabel}_${dateStr}.csv`);

    await writeCSV(csvPath, master);
    await writeCSV(datedCsvPath, master);

    currentJob.status = 'completed';
    currentJob.currentChunk = null;
    currentJob.lastError = null;
    currentJob.outputFile = 'output/shiprocket_orders_latest.csv';
    saveJob(currentJob);

    console.log(`Job completed. ${Object.keys(master).length} unique orders saved.`);
  } catch (err) {
    console.error(`Job failed: ${err.message}`);
    currentJob.status = 'failed';
    currentJob.lastError = err.message;
    saveJob(currentJob);
  } finally {
    currentJob = null;
  }
}

async function writeCSV(filepath, master) {
  const records = Object.values(master);
  if (records.length === 0) return;

  const columns = Object.keys(records[0]).map(key => ({
    id: key,
    title: key,
  }));

  const csvWriter = createObjectCsvWriter({
    path: filepath,
    header: columns,
  });

  await csvWriter.writeRecords(records);
  console.log(`CSV written: ${filepath} (${records.length} rows)`);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Shiprocket Local Fetcher</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 800px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 1.8rem; margin-bottom: 8px; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 0.95rem; }
  .btn-group { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 32px; }
  .btn { padding: 10px 20px; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn:hover:not(:disabled) { transform: translateY(-1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #2563eb; }
  .btn-success { background: #22c55e; color: #fff; }
  .btn-success:hover:not(:disabled) { background: #16a34a; }
  .btn-warning { background: #f59e0b; color: #fff; }
  .btn-warning:hover:not(:disabled) { background: #d97706; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn-danger:hover:not(:disabled) { background: #dc2626; }
  .btn-secondary { background: #475569; color: #fff; }
  .btn-secondary:hover:not(:disabled) { background: #334155; }
  .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #334155; }
  .card h2 { font-size: 1.1rem; margin-bottom: 12px; color: #f1f5f9; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .stat { background: #0f172a; padding: 12px; border-radius: 8px; }
  .stat-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 1.2rem; font-weight: 700; color: #e2e8f0; margin-top: 4px; }
  .stat-value.running { color: #22c55e; }
  .stat-value.completed { color: #3b82f6; }
  .stat-value.failed { color: #ef4444; }
  .stat-value.aborted { color: #f59e0b; }
  .progress-bar { width: 100%; height: 8px; background: #0f172a; border-radius: 4px; margin-top: 12px; overflow: hidden; }
  .progress-fill { height: 100%; background: #3b82f6; border-radius: 4px; transition: width 0.5s ease; }
  .progress-fill.completed { background: #22c55e; }
  .progress-fill.failed { background: #ef4444; }
  #error-box { display: none; background: #7f1d1d; border: 1px solid #dc2626; border-radius: 8px; padding: 12px; margin-top: 12px; color: #fca5a5; font-size: 0.85rem; }
  .log { background: #0f172a; border-radius: 8px; padding: 12px; font-family: 'Courier New', monospace; font-size: 0.8rem; max-height: 200px; overflow-y: auto; margin-top: 12px; color: #94a3b8; }
  .log-line { padding: 2px 0; }
  .log-line.error { color: #fca5a5; }
  .log-line.info { color: #67e8f9; }
  .log-line.success { color: #86efac; }
  .toast { display: none; position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-weight: 600; z-index: 999; }
  .toast.success { background: #166534; color: #86efac; border: 1px solid #22c55e; }
  .toast.error { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
</style>
</head>
<body>
<div class="container">
  <h1>Shiprocket Local Fetcher</h1>
  <p class="subtitle">Fetch order/shipment data from Shiprocket API and export as CSV</p>

  <div class="card">
    <h2>Fetch Orders</h2>
    <div class="btn-group">
      <button class="btn btn-primary" onclick="startJob(1)" id="btn-1">Fetch Today</button>
      <button class="btn btn-primary" onclick="startJob(3)" id="btn-3">Fetch Last 3 Days</button>
      <button class="btn btn-primary" onclick="startJob(7)" id="btn-7">Fetch Last 7 Days</button>
      <button class="btn btn-primary" onclick="startJob(28)" id="btn-28">Fetch Last 28 Days</button>
      <button class="btn btn-primary" onclick="startJob(90)" id="btn-90">Fetch Last 90 Days</button>
    </div>
    <div class="btn-group" style="margin-top:4px">
      <button class="btn btn-success" onclick="downloadCSV()" id="btn-download" disabled>Download Latest CSV</button>
      <button class="btn btn-secondary" onclick="checkStatus()">Check Status</button>
      <button class="btn btn-danger" onclick="resetMaster()" id="btn-reset">Reset Local Data</button>
    </div>
  </div>

  <div class="card" id="status-card" style="display:none">
    <h2>Job Status</h2>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Status</div>
        <div class="stat-value" id="stat-status">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Range</div>
        <div class="stat-value" id="stat-range">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Progress</div>
        <div class="stat-value" id="stat-progress">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Fetched Rows</div>
        <div class="stat-value" id="stat-fetched">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Unique Orders</div>
        <div class="stat-value" id="stat-unique">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Output File</div>
        <div class="stat-value" id="stat-output" style="font-size:0.8rem;word-break:break-all">-</div>
      </div>
    </div>
    <div class="progress-bar" id="progress-bar-container" style="display:none">
      <div class="progress-fill" id="progress-fill" style="width:0%"></div>
    </div>
    <div id="error-box"></div>
  </div>

  <div class="card" id="current-chunk-card" style="display:none">
    <h2>Current Chunk</h2>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Chunk</div>
        <div class="stat-value" id="chunk-index">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Date Range</div>
        <div class="stat-value" id="chunk-range" style="font-size:0.9rem">-</div>
      </div>
      <div class="stat">
        <div class="stat-label">Page</div>
        <div class="stat-value" id="chunk-page">-</div>
      </div>
    </div>
  </div>

  <div class="card" id="log-card" style="display:none">
    <h2>Activity Log</h2>
    <div class="log" id="log-container"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const POLL_INTERVAL = 2000;
let pollTimer = null;

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4000);
}

function addLog(msg, type) {
  const container = document.getElementById('log-container');
  const div = document.createElement('div');
  div.className = 'log-line ' + type;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  document.getElementById('log-card').style.display = 'block';
}

function setButtonsEnabled(enabled) {
  document.querySelectorAll('.btn-primary').forEach(b => b.disabled = !enabled);
  document.getElementById('btn-reset').disabled = !enabled;
}

function updateStatusUI(job) {
  const card = document.getElementById('status-card');
  card.style.display = 'block';

  const statusEl = document.getElementById('stat-status');
  statusEl.textContent = job.status || 'unknown';
  statusEl.className = 'stat-value ' + (job.status || '');

  document.getElementById('stat-range').textContent = (job.rangeLabel || '').replace(/_/g, ' ');

  if (job.totalChunks) {
    document.getElementById('stat-progress').textContent =
      job.completedChunks + ' / ' + job.totalChunks + ' chunks';
  } else {
    document.getElementById('stat-progress').textContent = '-';
  }

  document.getElementById('stat-fetched').textContent = job.totalFetchedRows || 0;
  document.getElementById('stat-unique').textContent = job.totalUniqueRows || 0;
  document.getElementById('stat-output').textContent = job.outputFile || '-';

  const barContainer = document.getElementById('progress-bar-container');
  const fill = document.getElementById('progress-fill');
  if (job.totalChunks && job.totalChunks > 0) {
    barContainer.style.display = 'block';
    const pct = Math.round((job.completedChunks / job.totalChunks) * 100);
    fill.style.width = pct + '%';
    fill.className = 'progress-fill';
    if (job.status === 'completed') fill.classList.add('completed');
    else if (job.status === 'failed') fill.classList.add('failed');
  } else {
    barContainer.style.display = 'none';
  }

  const errBox = document.getElementById('error-box');
  if (job.lastError) {
    errBox.style.display = 'block';
    errBox.textContent = 'Error: ' + job.lastError;
  } else {
    errBox.style.display = 'none';
  }

  const chunkCard = document.getElementById('current-chunk-card');
  if (job.currentChunk) {
    chunkCard.style.display = 'block';
    document.getElementById('chunk-index').textContent = job.currentChunk.index + ' / ' + job.totalChunks;
    document.getElementById('chunk-range').textContent = job.currentChunk.from + ' to ' + job.currentChunk.to;
    document.getElementById('chunk-page').textContent = job.currentChunk.page;
  } else {
    chunkCard.style.display = 'none';
  }

  const downloadBtn = document.getElementById('btn-download');
  if (job.status === 'completed') {
    downloadBtn.disabled = false;
  }

  if (job.status === 'running') {
    setButtonsEnabled(false);
    if (!pollTimer) startPolling();
  } else {
    setButtonsEnabled(true);
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (job.status === 'completed') {
      addLog('Job completed successfully!', 'success');
    } else if (job.status === 'failed') {
      addLog('Job failed: ' + (job.lastError || 'unknown error'), 'error');
    }
  }
}

async function startJob(days) {
  const labels = {1:'today',3:'last 3 days',7:'last 7 days',28:'last 28 days',90:'last 90 days'};
  addLog('Starting fetch for ' + labels[days] + '...', 'info');

  try {
    const res = await fetch('/start?days=' + days, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      showToast('Error: ' + data.error, 'error');
      addLog('Error: ' + data.error, 'error');
    } else {
      showToast('Fetch started for ' + labels[days], 'success');
      startPolling();
    }
  } catch (err) {
    showToast('Failed to start job', 'error');
    addLog('Failed to start job: ' + err.message, 'error');
  }
}

async function checkStatus() {
  try {
    const res = await fetch('/status');
    const job = await res.json();
    if (job && job.status) {
      updateStatusUI(job);
    } else {
      document.getElementById('status-card').style.display = 'block';
      document.getElementById('stat-status').textContent = 'idle';
      document.getElementById('stat-status').className = 'stat-value';
    }
    addLog('Status checked', 'info');
  } catch (err) {
    showToast('Failed to check status', 'error');
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/status');
      const job = await res.json();
      if (job && job.status) {
        updateStatusUI(job);
        if (job.status !== 'running' && pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } else {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        setButtonsEnabled(true);
      }
    } catch (err) {
      // ignore polling errors
    }
  }, POLL_INTERVAL);
}

async function downloadCSV() {
  try {
    const res = await fetch('/status');
    const job = await res.json();
    const file = job && job.outputFile ? job.outputFile : 'output/shiprocket_orders_latest.csv';
    window.location.href = '/download?file=' + encodeURIComponent(file);
    showToast('Download started', 'success');
  } catch (err) {
    window.location.href = '/download';
    showToast('Download started', 'success');
  }
}

async function resetMaster() {
  if (!confirm('Are you sure? This will delete all locally stored order data. This cannot be undone.')) return;
  if (!confirm('Really delete all data?')) return;

  try {
    const res = await fetch('/reset-master', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Local data reset successfully', 'success');
      addLog('Local data reset', 'info');
      document.getElementById('status-card').style.display = 'none';
      document.getElementById('current-chunk-card').style.display = 'none';
    } else {
      showToast('Reset failed', 'error');
    }
  } catch (err) {
    showToast('Reset failed', 'error');
  }
}
</script>
</body>
</html>
  `);
});

app.get('/status', (req, res) => {
  const job = loadJob();
  if (currentJob) {
    res.json(currentJob);
  } else if (job) {
    res.json(job);
  } else {
    res.json({ status: 'idle' });
  }
});

app.get('/chunks', (req, res) => {
  const days = parseInt(req.query.days) || 90;
  if (![1, 3, 7, 28, 90].includes(days)) {
    return res.status(400).json({ error: 'Invalid days. Allowed: 1, 3, 7, 28, 90' });
  }
  const chunks = generateChunks(days);
  res.json({ days, totalChunks: chunks.length, chunks });
});

app.post('/start', async (req, res) => {
  const days = parseInt(req.query.days);

  if (![1, 3, 7, 28, 90].includes(days)) {
    return res.status(400).json({ error: 'Invalid days. Allowed: 1, 3, 7, 28, 90' });
  }

  if (currentJob && currentJob.status === 'running') {
    return res.status(409).json({ error: 'A job is already running' });
  }

  abortController = { aborted: false };

  runJob(days).catch(err => {
    console.error('Job runner error:', err.message);
  });

  res.json({
    success: true,
    message: `Fetch started for last ${days} day(s)`,
  });
});

app.get('/download', (req, res) => {
  let filePath = path.join(OUTPUT_DIR, 'shiprocket_orders_latest.csv');

  if (req.query.file) {
    const requested = path.join(OUTPUT_DIR, path.basename(req.query.file));
    if (fs.existsSync(requested)) {
      filePath = requested;
    }
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'No CSV file available yet. Run a fetch first.' });
  }

  res.download(filePath);
});

app.post('/reset-master', (req, res) => {
  if (currentJob && currentJob.status === 'running') {
    return res.status(409).json({ error: 'Cannot reset while a job is running' });
  }

  const master = {};
  saveMaster(master);
  saveJob(null);

  const latestCsv = path.join(OUTPUT_DIR, 'shiprocket_orders_latest.csv');
  if (fs.existsSync(latestCsv)) {
    try { fs.unlinkSync(latestCsv); } catch (e) { /* ignore */ }
  }

  res.json({ success: true, message: 'Local data has been reset' });
});

ensureDirs();
saveJob(null);

app.listen(PORT, () => {
  console.log(`Shiprocket Local Fetcher running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Output directory: ${OUTPUT_DIR}`);
});
