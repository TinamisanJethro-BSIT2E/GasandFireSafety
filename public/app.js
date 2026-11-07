const page = document.body.dataset.page;
const API = '/api';
let currentUser = null;
let chart = null;

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    if (response.status === 401 && page !== 'login') location.href = '/';
    throw new Error(message);
  }
  return response;
}

function showNotice(text, type = 'success', target = 'notice') {
  const element = document.getElementById(target);
  if (!element) return;
  element.textContent = text;
  element.className = `notice show ${type}`;
  window.setTimeout(() => element.classList.remove('show'), 5000);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function shell() {
  const links = [
    ['dashboard', 'Dashboard', '/dashboard.html'],
    ['history', 'History', '/history.html'],
    ['settings', 'Settings', '/settings.html'],
    ['users', 'Users', '/users.html'],
    ['about', 'About', '/about.html']
  ];
  const pageLabels = Object.fromEntries(links.map(([key, label]) => [key, label]));
  document.body.classList.add('app-shell');
  document.body.insertAdjacentHTML('afterbegin', `
    <aside class="dashboard-sidebar">
      <a class="brand" href="/dashboard.html" style="text-decoration:none"><span class="brand-mark"><svg class="brand-symbol" viewBox="0 0 24 24" aria-hidden="true"><path class="brand-shield" d="M12 2.5 20 5.6v5.5c0 5.2-3.3 9-8 10.8-4.7-1.8-8-5.6-8-10.8V5.6l8-3.1Z"/><path class="brand-flame" d="M12.7 6.4c.5 2.1-1.8 3.1-1.7 5.1-1.1-.6-1.7-1.6-1.7-2.8-1.3 1.2-2.1 2.8-2.1 4.5a4.8 4.8 0 0 0 9.6 0c0-2.7-1.7-4.7-4.1-6.8Z"/></svg></span><span>Gas &amp; Fire Safety</span></a>
      <nav class="sidebar-links" aria-label="Main navigation">
        ${links.map(([key, label, href]) => `<a class="${page === key ? 'active' : ''}" href="${href}" data-role-link="${key}"><span class="sidebar-link-icon">${key === 'dashboard' ? '◫' : key === 'history' ? '▤' : key === 'settings' ? '⚙' : key === 'users' ? '♙' : 'ⓘ'}</span>${label}</a>`).join('')}
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-safety-note"><span class="sidebar-safety-dot"></span><span><strong>Local safety logic</strong><small>ESP32 protection runs offline</small></span></div>
      <button class="sidebar-logout" id="logoutButton" type="button"><span class="sidebar-link-icon">↪</span>Log out</button>
    </aside>
    <header class="dashboard-topbar">
      <div class="dashboard-context"><span class="context-dot"></span>Gas &amp; Fire Safety <span class="context-divider">/</span> ${pageLabels[page] || 'System'}</div>
    </header>
  `);
  document.getElementById('logoutButton').addEventListener('click', async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
      location.href = '/';
    } catch (error) {
      showNotice(`Logout failed: ${error.message}`, 'error');
    }
  });
}

async function protectPage() {
  try {
    const user = await (await api('/auth/me')).json();
    currentUser = user;
    if (user.mustChangePassword && page !== 'settings') location.href = '/settings.html';
    shell();
    if (user.role !== 'admin') {
      document.querySelectorAll('[data-role-link="settings"], [data-role-link="users"]').forEach((item) => item.remove());
    }
    if (page === 'users' && user.role !== 'admin') location.href = '/dashboard.html';
    return true;
  } catch (error) {
    if (error.message !== 'Failed to fetch') location.href = '/';
    return false;
  }
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusPresentation(status, online = true) {
  if (!online) return ['offline', 'Device Offline'];
  if (status === 'Fire Detected') return ['fire', 'Fire Detected'];
  if (status === 'Gas Leak') return ['gas', 'Gas Leak'];
  return ['normal', 'Normal'];
}

async function loadDashboard() {
  const data = await (await api('/status')).json();
  const reading = data.reading;
  const banner = document.getElementById('statusBanner');
  const [className, label] = statusPresentation(reading?.status, data.online);
  banner.className = `status-banner ${className}`;
  document.getElementById('systemStatus').textContent = label;
  document.getElementById('lastSeen').textContent = data.lastSeen ? `Last seen ${dateTime(data.lastSeen)}` : 'No device data received yet';
  document.getElementById('bannerConnection').innerHTML = `<span class="online-dot ${data.online ? 'online' : ''}"></span>${data.online ? 'Device online' : 'Device offline'}`;
  document.getElementById('onlineLabel').textContent = data.online ? 'Online' : 'Offline';
  document.getElementById('deviceIcon').classList.toggle('offline', !data.online);
  const dataStatusTag = document.getElementById('dataStatusTag');
  dataStatusTag.textContent = !reading ? 'WAITING FOR DATA' : data.online ? 'LIVE DATA' : 'DEVICE OFFLINE';
  dataStatusTag.className = `panel-tag ${!reading ? 'waiting' : data.online ? 'live' : 'offline'}`;
  const gasValue = reading?.gas_value;
  document.getElementById('gasValue').textContent = gasValue == null ? '— ADC' : `${gasValue} ADC`;
  document.getElementById('gasThreshold').textContent = `${data.threshold} ADC`;
  document.getElementById('gasFill').style.width = `${Math.min(100, (gasValue ?? 0) / 4095 * 100)}%`;
  document.getElementById('gasFill').style.backgroundColor =
    reading?.status === 'Fire Detected' ? '#b4232f' : (gasValue ?? 0) >= data.threshold ? '#c13c45' : '#19704d';
  document.getElementById('thresholdMarker').style.left = `${Math.min(100, data.threshold / 4095 * 100)}%`;
  document.getElementById('flameValue').textContent = reading ? (reading.flame_detected ? 'Detected' : 'Not detected') : '—';
  document.getElementById('flameValue').className = `metric-value ${reading?.flame_detected ? 'danger-text' : ''}`;
  document.getElementById('readingTime').textContent = reading ? `Updated ${dateTime(reading.created_at)}` : 'Waiting for first reading';
  const states = [
    ['fanState', reading?.fan_on, 'ON', 'OFF'],
    ['pumpState', reading?.pump_on, 'ON', 'OFF'],
    ['buzzerState', reading?.buzzer_on, 'ON', 'OFF'],
    ['regulatorState', reading?.regulator_open, 'OPEN', 'CLOSED']
  ];
  states.forEach(([id, active, on, off]) => {
    const element = document.getElementById(id);
    element.textContent = reading ? (active ? on : off) : '—';
    element.className = `pill ${!reading ? 'unknown' : active ? (id === 'regulatorState' ? 'warn' : 'danger') : (id === 'regulatorState' ? 'safe' : 'off')}`;
  });
  updateChart(data.points || [], data.threshold);
}

function updateChart(points, threshold) {
  const context = document.getElementById('gasChart');
  if (!context || typeof Chart === 'undefined') return;
  document.getElementById('chartEmpty').hidden = points.length > 0;
  const labels = points.map((item) => new Date(`${item.created_at.replace(' ', 'T')}Z`).toLocaleTimeString());
  const values = points.map((item) => item.gas_value);
  const thresholdValues = points.map(() => threshold);
  if (!chart) {
    chart = new Chart(context, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'MQ-6 raw ADC', data: values, borderColor: '#137451', backgroundColor: '#13745118', fill: true, tension: .32, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2 },
        { label: 'Threshold', data: thresholdValues, borderColor: '#c13c45', borderDash: [6, 5], pointRadius: 0, borderWidth: 2, fill: false }
      ] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        color: '#71817b',
        font: { family: 'Inter, Segoe UI, sans-serif' },
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 24, padding: 20 } },
          tooltip: { backgroundColor: '#172b26', padding: 11, cornerRadius: 8 }
        },
        scales: {
          y: { min: 0, max: 4095, title: { display: true, text: 'ADC counts' }, grid: { color: '#edf1ee' }, border: { display: false } },
          x: { ticks: { maxTicksLimit: 8 }, grid: { display: false }, border: { display: false } }
        }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.data.datasets[1].data = thresholdValues;
    chart.update('none');
  }
}

function connectLive() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${location.host}/live`);
  socket.addEventListener('message', (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      showNotice('Received an invalid live update. The dashboard will refresh automatically.', 'error');
      return;
    }
    if ((data.type === 'reading' || data.type === 'settings') && page === 'dashboard') {
      loadDashboard().catch((error) => showNotice(error.message, 'error'));
    }
  });
  socket.addEventListener('close', () => window.setTimeout(connectLive, 3000));
}

async function loadHistory() {
  const form = document.getElementById('historyFilters');
  const filterQuery = new URLSearchParams(new FormData(form));
  const query = new URLSearchParams(filterQuery);
  query.set('page', document.getElementById('historyPage').value || '1');
  const exportQuery = new URLSearchParams(filterQuery);
  document.getElementById('csvExport').href = `/api/history/export?${exportQuery}&format=csv`;
  document.getElementById('pdfExport').href = `/api/history/export?${exportQuery}&format=pdf`;
  const data = await (await api(`/history?${query}`)).json();
  document.getElementById('historyRows').innerHTML = data.items.length ? data.items.map((item) => {
    let actions = [];
    try {
      const parsed = JSON.parse(item.actions || '[]');
      if (Array.isArray(parsed)) actions = parsed.filter((action) => typeof action === 'string');
    } catch {}
    const eventClass = item.event_type === 'Fire Detected' ? 'fire' :
      item.event_type === 'Gas Leak' ? 'gas' : item.event_type === 'Cleared' ? 'cleared' : '';
    return `<tr><td>${escapeHtml(dateTime(item.created_at))}</td>
    <td><span class="event-badge ${eventClass}">${escapeHtml(item.event_type)}</span></td>
    <td>${item.gas_value ?? '—'}</td><td class="history-actions">${escapeHtml(actions.join(', ') || '—')}</td>
    <td class="history-details">${escapeHtml(item.details || '—')}</td></tr>`;
  }).join('') :
    '<tr><td colspan="5" class="muted">No events match these filters.</td></tr>';
  document.getElementById('pageLabel').textContent = `Page ${data.page} of ${data.pages} · ${data.total} events`;
  document.getElementById('prevPage').disabled = data.page <= 1;
  document.getElementById('nextPage').disabled = data.page >= data.pages;
  document.getElementById('historyPage').value = data.page;
}

async function loadSettings() {
  const settings = await (await api('/settings')).json();
  document.getElementById('thresholdInput').value = settings.gas_threshold;
  document.getElementById('delayInput').value = settings.detection_delay;
  document.getElementById('telegramEnabled').checked = settings.telegram_enabled;
  const adminControls = currentUser?.role === 'admin';
  document.querySelectorAll('[data-admin-only]').forEach((element) => {
    element.disabled = !adminControls;
  });
  if (!adminControls) document.getElementById('adminSettingsNote').textContent = 'Viewer access is read-only.';
}

async function loadUsers() {
  const data = await (await api('/users')).json();
  document.getElementById('userRows').innerHTML = data.users.map((user) => `
    <tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}</td><td>${escapeHtml(dateTime(user.created_at))}</td>
    <td>${user.id === currentUser.id ? '<span class="muted">Current user</span>' : `<button class="button danger small" data-delete-user="${user.id}">Delete</button>`}</td></tr>
  `).join('');
  document.querySelectorAll('[data-delete-user]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('Delete this viewer account?')) return;
    try {
      await api(`/users/${button.dataset.deleteUser}`, { method: 'DELETE' });
      showNotice('User deleted.');
      await loadUsers();
    } catch (error) { showNotice(error.message, 'error'); }
  }));
}

document.addEventListener('DOMContentLoaded', async () => {
  if (page === 'login') {
    document.getElementById('loginForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const response = await api('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        const data = await response.json();
        location.href = data.mustChangePassword ? '/settings.html' : '/dashboard.html';
      } catch (error) { showNotice(error.message, 'error'); }
    });
    try {
      const response = await fetch(`${API}/auth/me`, { credentials: 'same-origin' });
      if (response.ok) location.href = '/dashboard.html';
      else if (response.status !== 401) showNotice('Unable to verify the current session.', 'error');
    } catch {
      showNotice('Could not reach the server. Check that it is running and try again.', 'error');
    }
    return;
  }
  if (!await protectPage()) return;
  if (page === 'dashboard') {
    try { await loadDashboard(); connectLive(); } catch (error) { showNotice(error.message, 'error'); }
    window.setInterval(() => loadDashboard().catch((error) => showNotice(error.message, 'error')), 5000);
    const testButton = document.getElementById('buzzerTest');
    if (currentUser.role !== 'admin') testButton?.remove();
    testButton?.addEventListener('click', async () => {
      testButton.disabled = true;
      testButton.setAttribute('aria-busy', 'true');
      try {
        await api('/control', { method: 'POST', body: JSON.stringify({ command: 'buzzer_test' }) });
        showNotice('Buzzer test queued. The ESP32 will run it when connected.');
      } catch (error) { showNotice(error.message, 'error'); }
      finally {
        testButton.disabled = false;
        testButton.removeAttribute('aria-busy');
      }
    });
  }
  if (page === 'history') {
    const historyForm = document.getElementById('historyFilters');
    document.getElementById('historyFilters').addEventListener('submit', async (event) => {
      event.preventDefault(); document.getElementById('historyPage').value = '1';
      try { await loadHistory(); } catch (error) { showNotice(error.message, 'error'); }
    });
    historyForm.addEventListener('reset', () => {
      window.setTimeout(() => {
        document.getElementById('historyPage').value = '1';
        loadHistory().catch((error) => showNotice(error.message, 'error'));
      }, 0);
    });
    historyForm.addEventListener('input', () => {
      const query = new URLSearchParams(new FormData(historyForm));
      document.getElementById('csvExport').href = `/api/history/export?${query}&format=csv`;
      document.getElementById('pdfExport').href = `/api/history/export?${query}&format=pdf`;
    });
    historyForm.addEventListener('change', () => {
      const query = new URLSearchParams(new FormData(historyForm));
      document.getElementById('csvExport').href = `/api/history/export?${query}&format=csv`;
      document.getElementById('pdfExport').href = `/api/history/export?${query}&format=pdf`;
    });
    document.getElementById('prevPage').addEventListener('click', async () => {
      document.getElementById('historyPage').value = String(Math.max(1, Number(document.getElementById('historyPage').value) - 1));
      try { await loadHistory(); } catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('nextPage').addEventListener('click', async () => {
      document.getElementById('historyPage').value = String(Number(document.getElementById('historyPage').value) + 1);
      try { await loadHistory(); } catch (error) { showNotice(error.message, 'error'); }
    });
    try { await loadHistory(); } catch (error) { showNotice(error.message, 'error'); }
  }
  if (page === 'settings') {
    try { await loadSettings(); } catch (error) { showNotice(error.message, 'error'); }
    document.getElementById('settingsForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (currentUser.role !== 'admin') return;
      const body = {
        gas_threshold: Number(document.getElementById('thresholdInput').value),
        detection_delay: Number(document.getElementById('delayInput').value),
        telegram_enabled: document.getElementById('telegramEnabled').checked
      };
      try {
        await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
        showNotice('Settings saved. The ESP32 will fetch them on its next config poll.');
      } catch (error) { showNotice(error.message, 'error'); }
    });
    document.getElementById('passwordForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      try {
        await api('/auth/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        formElement.reset();
        showNotice('Password changed successfully.');
        document.getElementById('passwordReminder').textContent = '';
      } catch (error) { showNotice(error.message, 'error'); }
    });
    if (currentUser.mustChangePassword) document.getElementById('passwordReminder').textContent = 'Change the seeded administrator password before continuing.';
  }
  if (page === 'users') {
    try { await loadUsers(); } catch (error) { showNotice(error.message, 'error'); }
    document.getElementById('createUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      try {
        await api('/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
        formElement.reset();
        showNotice('Viewer account created.');
        await loadUsers();
      } catch (error) { showNotice(error.message, 'error'); }
    });
  }
});
