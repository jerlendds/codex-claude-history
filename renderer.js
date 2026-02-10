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

// Configure marked for syntax highlighting
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

// Format timestamp
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
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

// Format timestamp for message header
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

function renderFileHistorySnapshots(msg) {
  if (!msg.fileHistorySnapshots || msg.fileHistorySnapshots.length === 0) return '';

  const snapshots = msg.fileHistorySnapshots.filter(s => {
    const backups = s && s.trackedFileBackups ? Object.keys(s.trackedFileBackups) : [];
    return backups.length > 0;
  });
  if (snapshots.length === 0) return '';

  const uniqueFiles = new Set();
  for (const snapshot of snapshots) {
    for (const filePath of Object.keys(snapshot.trackedFileBackups || {})) {
      uniqueFiles.add(filePath);
    }
  }
  const fileCount = uniqueFiles.size;

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
      <summary class="file-history-summary">📁 File history (${fileCount} file${fileCount !== 1 ? 's' : ''})</summary>
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
        } catch (e) {
          codeEl.textContent = content;
        }

        details.dataset.loaded = 'true';
      } catch (e) {
        if (codeEl) codeEl.textContent = `Error loading snapshot: ${e.message}`;
        details.dataset.loaded = 'true';
      }
    });
  });
}

// Truncate project path
function truncateProject(project) {
  const parts = project.split('/');
  if (parts.length > 3) {
    return '.../' + parts.slice(-2).join('/');
  }
  return project;
}

// Load sessions from Claude Code history
async function loadSessions(options = {}) {
  const sessionList = document.getElementById('sessionList');
  const sessionCount = document.getElementById('sessionCount');

  try {
    if (isLoadingSessions) return;
    isLoadingSessions = true;

    const result = await ipcRenderer.invoke('get-sessions');

    if (result.error) {
      sessionList.innerHTML = `<div class="error-message">${result.error}</div>`;
      sessionCount.textContent = 'Error loading sessions';
      return;
    }

    currentSessions = result.sessions;

    if (currentSessions.length === 0) {
      sessionList.innerHTML = '<div class="loading">No sessions found</div>';
      sessionCount.textContent = '0 sessions';
      return;
    }

    sessionCount.textContent = `${currentSessions.length} session${currentSessions.length !== 1 ? 's' : ''}`;

    // Render session list
    sessionList.innerHTML = currentSessions.map((session, index) => `
      <div class="session-item" data-session-id="${session.id}" data-locator="${escapeHtml(session.locator || '')}" data-source="${escapeHtml(session.source || 'claude')}">
        <div class="session-timestamp">${formatTimestamp(session.timestamp)}</div>
        <div class="session-preview">${escapeHtml(session.display)}</div>
        <div class="session-meta">
          <div class="session-project">${escapeHtml(truncateProject(session.project))}</div>
          <div class="session-messages">${session.messageCount} msg</div>
        </div>
      </div>
    `).join('');

    // Add click handlers
    document.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', () => {
        const sessionId = item.getAttribute('data-session-id');
        const locator = item.getAttribute('data-locator');
        const source = item.getAttribute('data-source') || 'claude';
        currentSessionLocator = locator;
        loadSessionDetails(sessionId, locator, source);

        // Update active state
        document.querySelectorAll('.session-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
      });
    });

    // Preserve the active selection across refreshes.
    if (currentSessionId && currentSessionSource) {
      const selected = document.querySelector(
        `.session-item[data-session-id="${CSS.escape(currentSessionId)}"][data-source="${CSS.escape(currentSessionSource)}"]`
      );
      if (selected) selected.classList.add('active');
    }

  } catch (error) {
    sessionList.innerHTML = `<div class="error-message">Error: ${error.message}</div>`;
    sessionCount.textContent = 'Error';
  } finally {
    isLoadingSessions = false;
  }
}

// Load full session conversation
async function loadSessionDetails(sessionId, locator, source, options = {}) {
  const chatContainer = document.getElementById('chatContainer');
  const chatHeader = document.getElementById('chatHeader');

  currentSessionId = sessionId;
  currentSessionSource = source || 'claude';
  currentSessionLocator = locator;

  if (isLoadingSessionDetails) return;
  isLoadingSessionDetails = true;

  const prevScrollTop = chatContainer.scrollTop;
  const preserveScroll = !!options.preserveScroll;

  // Show loading state (skip during background refresh)
  if (!options.silent) {
    chatContainer.innerHTML = '<div class="loading">Loading conversation...</div>';
  }

  try {
    const result = await ipcRenderer.invoke('get-session-details', sessionId, locator, currentSessionSource);

    if (result.error) {
      chatContainer.innerHTML = `<div class="error-message">${result.error}</div>`;
      return;
    }

    const session = currentSessions.find(s => s.id === sessionId && (s.source || 'claude') === currentSessionSource);
    const assistantName = currentSessionSource === 'codex' ? 'Codex' : 'Claude';

    // Update header
    chatHeader.innerHTML = `
      <div class="session-header">
        <div class="session-title">${escapeHtml(session ? session.display : '')}</div>
        <div class="session-info">
          <span>${session ? formatTimestamp(session.timestamp) : ''}</span>
          <span>•</span>
          <span>${escapeHtml(session ? session.project : '')}</span>
          <span>•</span>
          <span>${result.messages.length} messages</span>
        </div>
      </div>
    `;

    // Render messages
    chatContainer.innerHTML = result.messages.map(msg => {
      let contentHtml = '';

      // Process content with markdown
      if (msg.content) {
        contentHtml = marked.parse(msg.content);
      }

      const contentSection = contentHtml
        ? `<div class="message-content">${contentHtml}</div>`
        : '';

      // Add tool use information if present
      let toolUsesHtml = '';
      if (msg.toolUses && msg.toolUses.length > 0) {
        const toolNames = msg.toolUses.map(tool => tool.name).join(', ');
        toolUsesHtml = `
          <div class="tool-uses">
            <div class="tool-use-title">🔧 Tools used:</div>
            <div class="tool-use-item">${escapeHtml(toolNames)}</div>
          </div>
        `;
      }

      const fileHistoryHtml = renderFileHistorySnapshots(msg);

      return `
        <div class="message ${msg.role}">
          <div class="message-header">
            <div class="message-role ${msg.role}">${msg.role === 'user' ? 'You' : assistantName}</div>
            <div class="message-timestamp">${formatMessageTimestamp(msg.timestamp)}</div>
          </div>
          ${contentSection}
          ${toolUsesHtml}
          ${fileHistoryHtml}
        </div>
      `;
    }).join('');

    attachFileHistoryHandlers(chatContainer);

    // Keep scroll position for background refreshes.
    chatContainer.scrollTop = preserveScroll ? Math.min(prevScrollTop, chatContainer.scrollHeight) : 0;

  } catch (error) {
    chatContainer.innerHTML = `<div class="error-message">Error loading conversation: ${error.message}</div>`;
  } finally {
    isLoadingSessionDetails = false;
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  loadSessions();

  // Periodically refresh the session list and the currently open conversation.
  // Keep this in the renderer so it updates even if the main process stays unchanged.
  refreshIntervalId = setInterval(async () => {
    try {
      await loadSessions({ silent: true });
      if (currentSessionId && currentSessionLocator && currentSessionSource) {
        await loadSessionDetails(currentSessionId, currentSessionLocator, currentSessionSource, {
          preserveScroll: true,
          silent: true
        });
      }
    } catch (e) {
      // Ignore periodic refresh errors; the UI will surface errors when user interacts.
    }
  }, 15000);
});

window.addEventListener('beforeunload', () => {
  if (refreshIntervalId) clearInterval(refreshIntervalId);
  refreshIntervalId = null;
});
