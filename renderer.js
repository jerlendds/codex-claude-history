const { ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');

let currentSessions = [];
let currentSessionId = null;
let currentSessionSource = 'claude';
let currentSessionLocator = null;
let refreshIntervalId = null;
let isLoadingSessions = false;
let isLoadingSessionDetails = false;
const EVENT_LOG_HEIGHT_STORAGE_KEY = 'hud:event-log-height';
const DEFAULT_EVENT_LOG_HEIGHT = 320;

const BASE_GRAPH_NODES = [
  { id: 'session', label: 'Session File Root', glyph: 'SES', x: 148, y: 110 },
  { id: 'project', label: 'Project Path Anchor', glyph: 'PRJ', x: 268, y: 310 },
  { id: 'prompt', label: 'User Prompt Segment', glyph: 'USR', x: 424, y: 108 },
  { id: 'response', label: 'Assistant Response Block', glyph: 'AST', x: 656, y: 186 },
  { id: 'tool', label: 'Tool Invocation Trace', glyph: 'TLU', x: 862, y: 108 },
  { id: 'snapshot', label: 'File History Snapshot', glyph: 'FSH', x: 905, y: 332 },
  { id: 'timeline', label: 'Timestamp Timeline', glyph: 'TIM', x: 1068, y: 220 }
];

const BASE_GRAPH_EDGES = [
  { from: 'session', to: 'project' },
  { from: 'session', to: 'prompt' },
  { from: 'prompt', to: 'response' },
  { from: 'response', to: 'tool' },
  { from: 'tool', to: 'snapshot' },
  { from: 'snapshot', to: 'project' },
  { from: 'response', to: 'timeline' },
  { from: 'project', to: 'timeline' },
  { from: 'session', to: 'timeline' }
];

marked.setOptions({
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (err) {
        console.error('Highlight error:', err);
      }
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
  gfm: true
});

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return 'Today, ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (days === 1) {
    return 'Yesterday, ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } else if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatMessageTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  });
}

function truncateProject(project) {
  if (!project || typeof project !== 'string') return 'unknown/project';
  const parts = project.split('/');
  if (parts.length > 3) {
    return '.../' + parts.slice(-2).join('/');
  }
  return project;
}

function truncateText(text, max = 26) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function renderSessionPreviewMarkdown(text) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  const escaped = escapeHtml(compact);

  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function getSessionPriority(session) {
  const timestamp = new Date(session.timestamp).getTime();
  const ageHours = Number.isNaN(timestamp) ? 9999 : (Date.now() - timestamp) / (1000 * 60 * 60);

  if (session.messageCount >= 80 || ageHours <= 12) {
    return { label: 'P1', className: 'priority-p1' };
  }

  if (session.messageCount >= 30 || ageHours <= 48) {
    return { label: 'P2', className: 'priority-p2' };
  }

  return { label: 'P3', className: 'priority-p3' };
}

function setMetricValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value);
}

function getResponsivePanelMinimums() {
  if (window.innerWidth <= 640) return { graphMin: 150, eventMin: 110 };
  if (window.innerWidth <= 860) return { graphMin: 170, eventMin: 120 };
  if (window.innerWidth <= 1120) return { graphMin: 190, eventMin: 130 };
  return { graphMin: 210, eventMin: 150 };
}

function getSplitterSize(mainPanel) {
  const raw = getComputedStyle(mainPanel).getPropertyValue('--resizer-size');
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 10;
}

function getEventLogBounds(mainPanel) {
  if (!mainPanel) return null;
  const header = mainPanel.querySelector('.chat-header');
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const splitSize = getSplitterSize(mainPanel);
  const { graphMin, eventMin } = getResponsivePanelMinimums();
  const freeHeight = Math.max(0, mainPanel.clientHeight - headerHeight - splitSize);
  const max = Math.max(eventMin, freeHeight - graphMin);
  return { min: eventMin, max };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getStoredEventLogHeight() {
  try {
    const value = Number.parseFloat(localStorage.getItem(EVENT_LOG_HEIGHT_STORAGE_KEY));
    return Number.isFinite(value) ? value : null;
  } catch (error) {
    return null;
  }
}

function setStoredEventLogHeight(height) {
  try {
    localStorage.setItem(EVENT_LOG_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  } catch (error) {
    // Ignore persistence issues in restricted environments.
  }
}

function readCurrentEventLogHeight(mainPanel, eventLogPanel) {
  if (!mainPanel) return DEFAULT_EVENT_LOG_HEIGHT;
  const raw = getComputedStyle(mainPanel).getPropertyValue('--event-log-height');
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed)) return parsed;
  return eventLogPanel ? eventLogPanel.getBoundingClientRect().height : DEFAULT_EVENT_LOG_HEIGHT;
}

function applyEventLogHeight(height, options = {}) {
  const { persist = false } = options;
  const mainPanel = document.querySelector('.main-panel');
  const eventLogPanel = document.querySelector('.event-log-panel');
  if (!mainPanel || !eventLogPanel) return;

  const bounds = getEventLogBounds(mainPanel);
  if (!bounds) return;

  const target = Number.isFinite(height) ? height : DEFAULT_EVENT_LOG_HEIGHT;
  const clamped = clamp(target, bounds.min, bounds.max);

  mainPanel.style.setProperty('--event-log-height', `${Math.round(clamped)}px`);
  if (persist) setStoredEventLogHeight(clamped);
}

function initializeEventLogResizer() {
  const resizer = document.getElementById('eventLogResizer');
  const mainPanel = document.querySelector('.main-panel');
  const eventLogPanel = document.querySelector('.event-log-panel');
  if (!resizer || !mainPanel || !eventLogPanel) return;

  const storedHeight = getStoredEventLogHeight();
  applyEventLogHeight(storedHeight ?? DEFAULT_EVENT_LOG_HEIGHT, { persist: false });

  let dragging = false;
  let activePointerId = null;
  let startY = 0;
  let startHeight = 0;

  const finishDrag = (event) => {
    if (!dragging) return;
    if (event && activePointerId !== null && event.pointerId !== activePointerId) return;

    dragging = false;
    resizer.classList.remove('is-active');
    document.body.classList.remove('is-resizing');

    if (activePointerId !== null && resizer.hasPointerCapture(activePointerId)) {
      resizer.releasePointerCapture(activePointerId);
    }

    const finalHeight = readCurrentEventLogHeight(mainPanel, eventLogPanel);
    applyEventLogHeight(finalHeight, { persist: true });
    activePointerId = null;
  };

  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();

    dragging = true;
    activePointerId = event.pointerId;
    startY = event.clientY;
    startHeight = eventLogPanel.getBoundingClientRect().height;

    resizer.setPointerCapture(activePointerId);
    resizer.classList.add('is-active');
    document.body.classList.add('is-resizing');
  });

  resizer.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== activePointerId) return;
    const delta = startY - event.clientY;
    applyEventLogHeight(startHeight + delta, { persist: false });
  });

  resizer.addEventListener('pointerup', finishDrag);
  resizer.addEventListener('pointercancel', finishDrag);
  resizer.addEventListener('lostpointercapture', finishDrag);

  resizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 16;
    const current = readCurrentEventLogHeight(mainPanel, eventLogPanel);
    const bounds = getEventLogBounds(mainPanel);
    if (!bounds) return;

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      applyEventLogHeight(current + step, { persist: true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      applyEventLogHeight(current - step, { persist: true });
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyEventLogHeight(bounds.min, { persist: true });
    } else if (event.key === 'End') {
      event.preventDefault();
      applyEventLogHeight(bounds.max, { persist: true });
    }
  });

  resizer.addEventListener('dblclick', () => {
    applyEventLogHeight(DEFAULT_EVENT_LOG_HEIGHT, { persist: true });
  });

  window.addEventListener('resize', () => {
    if (dragging) return;
    applyEventLogHeight(readCurrentEventLogHeight(mainPanel, eventLogPanel), { persist: false });
  });
}

function setEventLogStatus(label, mode = 'neutral') {
  const statusEl = document.getElementById('eventLogStatus');
  if (!statusEl) return;

  statusEl.textContent = label;
  statusEl.classList.remove('is-live', 'is-alert');

  if (mode === 'live') statusEl.classList.add('is-live');
  if (mode === 'alert') statusEl.classList.add('is-alert');
}

function stringifyToolPayload(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  try {
    return JSON.stringify(payload, null, 2);
  } catch (error) {
    return String(payload);
  }
}

function getToolCommandText(toolUse) {
  if (!toolUse || typeof toolUse !== 'object') return '';
  if (typeof toolUse.command === 'string' && toolUse.command.trim()) return toolUse.command.trim();
  if (typeof toolUse.input === 'string' && toolUse.input.trim()) return toolUse.input.trim();
  if (typeof toolUse.arguments === 'string' && toolUse.arguments.trim()) return toolUse.arguments.trim();
  return '';
}

function renderToolTracePanel(toolUses) {
  const names = toolUses.map(tool => tool.name || 'tool').join(' | ');

  const detailRows = toolUses.map((tool, index) => {
    const name = tool.name || `tool-${index + 1}`;
    const command = getToolCommandText(tool);
    const payload = stringifyToolPayload(tool.payload);
    const callId = tool.callId ? String(tool.callId) : '';

    return `
      <div class="tool-command-entry">
        <div class="tool-command-header">
          <span class="tool-command-name">${escapeHtml(name)}</span>
          ${callId ? `<span class="tool-command-id">${escapeHtml(callId)}</span>` : ''}
        </div>
        <pre class="tool-command-pre"><code>${escapeHtml(command || 'No command payload captured for this tool call.')}</code></pre>
        ${payload && payload !== command
          ? `<pre class="tool-command-payload"><code>${escapeHtml(payload)}</code></pre>`
          : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="tool-uses">
      <button type="button" class="tool-use-toggle" aria-expanded="false">
        <span class="tool-use-head">
          <span class="tool-use-title">TOOL TRACE</span>
          <span class="tool-use-item">${escapeHtml(names)}</span>
        </span>
        <span class="tool-use-chevron" aria-hidden="true"></span>
      </button>
      <div class="tool-use-details-wrap">
        <div class="tool-use-details">
          ${detailRows}
        </div>
      </div>
    </div>
  `;
}

function attachToolTraceHandlers(container) {
  container.querySelectorAll('.tool-use-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const panel = toggle.closest('.tool-uses');
      if (!panel) return;

      const expanded = panel.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  });
}

function updateHeaderSession(session, messageCount = 0) {
  const titleEl = document.getElementById('headerSessionTitle');
  const infoEl = document.getElementById('headerSessionInfo');
  if (!titleEl || !infoEl) return;

  if (!session) {
    titleEl.textContent = 'NO ACTIVE SESSION';
    titleEl.dataset.ghost = 'NO ACTIVE SESSION';
    infoEl.textContent = 'Select a session to begin timeline replay and telemetry.';
    return;
  }

  const title = session.display || `${(session.source || 'claude').toUpperCase()} SESSION`;
  const source = (session.source || 'claude').toUpperCase();
  const project = escapeHtml(session.project || 'unknown/project');

  titleEl.textContent = title;
  titleEl.dataset.ghost = title;
  infoEl.innerHTML = [
    `<span>${source}</span>`,
    '<span>•</span>',
    `<span>${formatTimestamp(session.timestamp)}</span>`,
    '<span>•</span>',
    `<span>${project}</span>`,
    '<span>•</span>',
    `<span>${messageCount} events</span>`
  ].join('');
}

function guessLanguageFromFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.tsx')) return 'typescript';
  if (lower.endsWith('.js')) return 'javascript';
  if (lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.jsonl')) return 'json';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.html')) return 'xml';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.sh')) return 'bash';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.c')) return 'c';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx')) return 'cpp';
  return null;
}

function deriveTelemetryMetrics(messageCount, toolCount, snapshotCount) {
  const nodeCount = Math.max(62, Math.round(30 + messageCount * 0.55 + toolCount * 2 + snapshotCount * 1.4));
  const relationCount = Math.max(189, Math.round(nodeCount * 2.2 + snapshotCount * 1.8));
  return { nodeCount, relationCount };
}

function countToolUses(messages) {
  return messages.reduce((total, msg) => total + ((msg.toolUses && msg.toolUses.length) || 0), 0);
}

function countSnapshots(messages) {
  return messages.reduce((total, msg) => total + ((msg.fileHistorySnapshots && msg.fileHistorySnapshots.length) || 0), 0);
}

function buildGraphModel(messages = []) {
  const nodes = BASE_GRAPH_NODES.map(node => ({ ...node, active: false }));
  const edges = BASE_GRAPH_EDGES.map(edge => ({ ...edge, passive: true }));

  const messageIntensity = Math.min(1, messages.length / 40);
  const activeBaseCount = Math.max(2, Math.round(2 + messageIntensity * 5));

  for (let i = 0; i < nodes.length; i += 1) {
    if (i < activeBaseCount || (messages.length > 0 && i % 2 === 0)) {
      nodes[i].active = true;
    }
  }

  const activeEdges = Math.max(2, Math.round(2 + messageIntensity * edges.length));
  for (let i = 0; i < edges.length; i += 1) {
    edges[i].passive = i >= activeEdges;
  }

  const uniqueTools = [...new Set(
    messages
      .flatMap(msg => (msg.toolUses || []).map(tool => tool.name))
      .filter(Boolean)
  )].slice(0, 3);

  uniqueTools.forEach((toolName, index) => {
    const id = `tool-ext-${index}`;
    nodes.push({
      id,
      label: truncateText(toolName, 22),
      glyph: `T${index + 1}`,
      x: 684 + index * 154,
      y: 414 + (index % 2) * 78,
      active: true
    });

    edges.push({ from: 'tool', to: id, passive: false });
    edges.push({ from: 'response', to: id, passive: index % 2 !== 0 });
  });

  return { nodes, edges };
}

function buildCurvePath(source, target, index) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const mx = source.x + dx / 2;
  const my = source.y + dy / 2;
  const bend = ((index % 2 === 0 ? -1 : 1) * (36 + (index % 3) * 18));
  const cx = mx + (dy * 0.15);
  const cy = my + bend;

  return `M ${source.x} ${source.y} Q ${cx} ${cy} ${target.x} ${target.y}`;
}

function renderGraphCanvas(messages = []) {
  const graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;

  const { nodes, edges } = buildGraphModel(messages);
  const nodeMap = new Map(nodes.map(node => [node.id, node]));

  const edgesMarkup = edges.map((edge, index) => {
    const source = nodeMap.get(edge.from);
    const target = nodeMap.get(edge.to);
    if (!source || !target) return '';

    const path = buildCurvePath(source, target, index);
    const passiveClass = edge.passive ? ' passive' : '';
    return `<path class="graph-edge${passiveClass}" d="${path}"></path>`;
  }).join('');

  const nodesMarkup = nodes.map(node => {
    const width = 170;
    const height = 46;
    const x = node.x - width / 2;
    const y = node.y - height / 2;
    const activeClass = node.active ? ' active' : '';

    return `
      <g class="graph-node${activeClass}" transform="translate(${x}, ${y})">
        <rect class="graph-node-panel" width="${width}" height="${height}"></rect>
        <line x1="0" y1="14" x2="${width}" y2="14" stroke="rgba(255,255,255,0.08)" />
        <text class="graph-node-glyph" x="8" y="11">${escapeHtml(node.glyph)}</text>
        <text class="graph-node-label" x="8" y="31">${escapeHtml(node.label)}</text>
        <circle class="graph-anchor" cx="${width - 5}" cy="${height / 2}" r="2"></circle>
      </g>
    `;
  }).join('');

  graphCanvas.innerHTML = `
    <defs>
      <pattern id="graphGridPattern" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1"></path>
      </pattern>
      <linearGradient id="edgeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="rgba(87, 255, 143, 0.2)"></stop>
        <stop offset="50%" stop-color="rgba(87, 255, 143, 0.95)"></stop>
        <stop offset="100%" stop-color="rgba(87, 255, 143, 0.2)"></stop>
      </linearGradient>
    </defs>
    <rect class="graph-grid" x="0" y="0" width="1200" height="640" fill="url(#graphGridPattern)"></rect>
    <g class="graph-edges">${edgesMarkup}</g>
    <g class="graph-nodes">${nodesMarkup}</g>
  `;
}

function renderFileHistorySnapshots(msg) {
  if (!msg.fileHistorySnapshots || msg.fileHistorySnapshots.length === 0) return '';

  const snapshots = msg.fileHistorySnapshots.filter(snapshot => {
    const backups = snapshot && snapshot.trackedFileBackups ? Object.keys(snapshot.trackedFileBackups) : [];
    return backups.length > 0;
  });

  if (snapshots.length === 0) return '';

  const uniqueFiles = new Set();
  for (const snapshot of snapshots) {
    for (const filePath of Object.keys(snapshot.trackedFileBackups || {})) {
      uniqueFiles.add(filePath);
    }
  }

  const snapshotsHtml = snapshots.map(snapshot => {
    const entries = Object.entries(snapshot.trackedFileBackups || {}).sort((a, b) => a[0].localeCompare(b[0]));
    const snapshotTime = snapshot.timestamp || msg.timestamp;

    return `
      <div class="file-history-snapshot">
        <div class="file-history-snapshot-header">
          <div class="file-history-snapshot-title">Snapshot</div>
          <div class="file-history-snapshot-time">${formatMessageTimestamp(snapshotTime)}</div>
        </div>
        <div class="file-history-files">
          ${entries.map(([filePath, meta]) => `
            <details class="file-snapshot" data-backup-file="${escapeHtml(meta.backupFileName)}" data-file-path="${escapeHtml(filePath)}">
              <summary class="file-snapshot-summary">
                <span class="file-snapshot-path">${escapeHtml(filePath)}</span>
                <span class="file-snapshot-version">v${meta.version}</span>
              </summary>
              <div class="file-snapshot-meta">${meta.backupTime ? escapeHtml(new Date(meta.backupTime).toLocaleString()) : ''}</div>
              <div class="file-snapshot-warning" hidden></div>
              <pre class="file-snapshot-pre"><code class="hljs"></code></pre>
            </details>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');

  return `
    <details class="file-history">
      <summary class="file-history-summary">FILE HISTORY (${uniqueFiles.size} file${uniqueFiles.size !== 1 ? 's' : ''})</summary>
      ${snapshotsHtml}
    </details>
  `;
}

function attachFileHistoryHandlers(container) {
  container.querySelectorAll('.file-snapshot').forEach(details => {
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      if (details.dataset.loaded === 'true' || details.dataset.loaded === 'loading') return;

      const backupFileName = details.getAttribute('data-backup-file');
      const filePath = details.getAttribute('data-file-path');
      const codeEl = details.querySelector('code');
      const warningEl = details.querySelector('.file-snapshot-warning');

      details.dataset.loaded = 'loading';
      if (codeEl) codeEl.textContent = 'Loading…';
      if (warningEl) warningEl.hidden = true;

      try {
        const result = await ipcRenderer.invoke('get-file-history-file', currentSessionId, backupFileName);
        if (result.error) {
          if (codeEl) codeEl.textContent = result.error;
          details.dataset.loaded = 'true';
          return;
        }

        const content = result.content || '';
        const language = guessLanguageFromFilePath(filePath);

        if (warningEl && result.truncated) {
          warningEl.hidden = false;
          warningEl.textContent = `Showing first 2 MiB (file is ${Math.round(result.originalBytes / 1024)} KiB)`;
        }

        if (!codeEl) return;

        try {
          if (language && hljs.getLanguage(language)) {
            codeEl.innerHTML = hljs.highlight(content, { language }).value;
          } else {
            codeEl.innerHTML = hljs.highlightAuto(content).value;
          }
        } catch (error) {
          codeEl.textContent = content;
        }

        details.dataset.loaded = 'true';
      } catch (error) {
        if (codeEl) codeEl.textContent = `Error loading snapshot: ${error.message}`;
        details.dataset.loaded = 'true';
      }
    });
  });
}

async function loadSessions() {
  const sessionList = document.getElementById('sessionList');
  const sessionCount = document.getElementById('sessionCount');

  try {
    if (isLoadingSessions) return;
    isLoadingSessions = true;

    const result = await ipcRenderer.invoke('get-sessions');

    if (result.error) {
      sessionList.innerHTML = `<div class="error-message">${result.error}</div>`;
      sessionCount.textContent = 'ERROR';
      setMetricValue('metricSessionCount', 0);
      return;
    }

    currentSessions = result.sessions;
    setMetricValue('metricSessionCount', currentSessions.length);

    if (currentSessions.length === 0) {
      sessionList.innerHTML = '<div class="loading">No sessions found</div>';
      sessionCount.textContent = '0 sessions';
      updateHeaderSession(null, 0);
      setMetricValue('metricEventCount', 0);
      renderGraphCanvas([]);
      setEventLogStatus('STANDBY');
      return;
    }

    sessionCount.textContent = `${currentSessions.length} session${currentSessions.length !== 1 ? 's' : ''} indexed`;

    sessionList.innerHTML = currentSessions.map(session => {
      const priority = getSessionPriority(session);
      const source = (session.source || 'claude').toUpperCase();
      const preview = renderSessionPreviewMarkdown(session.display || 'No prompt captured');

      return `
        <div class="session-item" data-session-id="${session.id}" data-locator="${escapeHtml(session.locator || '')}" data-source="${escapeHtml(session.source || 'claude')}">
          <div class="session-row">
            <div class="session-timestamp">${formatTimestamp(session.timestamp)}</div>
            <div class="priority-badge ${priority.className}">${priority.label}</div>
          </div>
          <div class="session-preview">${preview}</div>
          <div class="session-meta">
            <div class="session-project">${escapeHtml(truncateProject(session.project))}</div>
            <div class="session-messages">${session.messageCount} EVT • ${source}</div>
          </div>
        </div>
      `;
    }).join('');

    document.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', () => {
        const sessionId = item.getAttribute('data-session-id');
        const locator = item.getAttribute('data-locator');
        const source = item.getAttribute('data-source') || 'claude';

        currentSessionLocator = locator;
        loadSessionDetails(sessionId, locator, source);

        document.querySelectorAll('.session-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
    });

    if (currentSessionId && currentSessionSource) {
      const selected = document.querySelector(
        `.session-item[data-session-id="${CSS.escape(currentSessionId)}"][data-source="${CSS.escape(currentSessionSource)}"]`
      );
      if (selected) selected.classList.add('active');
    }
  } catch (error) {
    sessionList.innerHTML = `<div class="error-message">Error: ${error.message}</div>`;
    sessionCount.textContent = 'ERROR';
    setMetricValue('metricSessionCount', 0);
  } finally {
    isLoadingSessions = false;
  }
}

async function loadSessionDetails(sessionId, locator, source, options = {}) {
  const chatContainer = document.getElementById('chatContainer');

  currentSessionId = sessionId;
  currentSessionSource = source || 'claude';
  currentSessionLocator = locator;

  if (isLoadingSessionDetails) return;
  isLoadingSessionDetails = true;

  const prevScrollTop = chatContainer.scrollTop;
  const preserveScroll = !!options.preserveScroll;

  if (!options.silent) {
    chatContainer.innerHTML = '<div class="loading">Loading conversation...</div>';
    setEventLogStatus('SYNCING');
  }

  try {
    const result = await ipcRenderer.invoke('get-session-details', sessionId, locator, currentSessionSource);

    if (result.error) {
      chatContainer.innerHTML = `<div class="error-message">${result.error}</div>`;
      setEventLogStatus('FAULT', 'alert');
      return;
    }

    const session = currentSessions.find(s => s.id === sessionId && (s.source || 'claude') === currentSessionSource);
    const assistantName = currentSessionSource === 'codex' ? 'CODEX' : 'CLAUDE';

    updateHeaderSession(session, result.messages.length);

    chatContainer.innerHTML = result.messages.map(msg => {
      let contentHtml = '';
      if (msg.content) {
        contentHtml = marked.parse(msg.content);
      }

      const contentSection = contentHtml ? `<div class="message-content">${contentHtml}</div>` : '';

      let toolUsesHtml = '';
      if (msg.toolUses && msg.toolUses.length > 0) {
        toolUsesHtml = renderToolTracePanel(msg.toolUses);
      }

      const fileHistoryHtml = renderFileHistorySnapshots(msg);

      return `
        <div class="message ${msg.role}">
          <div class="message-header">
            <div class="message-role ${msg.role}">${msg.role === 'user' ? 'USER' : assistantName}</div>
            <div class="message-timestamp">${formatMessageTimestamp(msg.timestamp)}</div>
          </div>
          ${contentSection}
          ${toolUsesHtml}
          ${fileHistoryHtml}
        </div>
      `;
    }).join('');

    attachFileHistoryHandlers(chatContainer);
    attachToolTraceHandlers(chatContainer);
    chatContainer.scrollTop = preserveScroll ? Math.min(prevScrollTop, chatContainer.scrollHeight) : 0;

    const toolCount = countToolUses(result.messages);
    const snapshotCount = countSnapshots(result.messages);
    const metrics = deriveTelemetryMetrics(result.messages.length, toolCount, snapshotCount);

    setMetricValue('metricNodeCount', metrics.nodeCount);
    setMetricValue('metricRelationCount', metrics.relationCount);
    setMetricValue('metricEventCount', result.messages.length);

    renderGraphCanvas(result.messages);
    setEventLogStatus('LIVE', 'live');
  } catch (error) {
    chatContainer.innerHTML = `<div class="error-message">Error loading conversation: ${error.message}</div>`;
    setEventLogStatus('FAULT', 'alert');
  } finally {
    isLoadingSessionDetails = false;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initializeEventLogResizer();
  updateHeaderSession(null, 0);
  renderGraphCanvas([]);
  setMetricValue('metricSessionCount', 0);
  setMetricValue('metricEventCount', 0);
  setEventLogStatus('STANDBY');

  loadSessions();

  refreshIntervalId = setInterval(async () => {
    try {
      await loadSessions();
      if (currentSessionId && currentSessionLocator && currentSessionSource) {
        await loadSessionDetails(currentSessionId, currentSessionLocator, currentSessionSource, {
          preserveScroll: true,
          silent: true
        });
      }
    } catch (error) {
      // Ignore background refresh failures; interactive actions show concrete errors.
    }
  }, 15000);
});

window.addEventListener('beforeunload', () => {
  if (refreshIntervalId) clearInterval(refreshIntervalId);
  refreshIntervalId = null;
});
