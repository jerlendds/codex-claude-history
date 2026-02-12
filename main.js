const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

function getClaudeConfigPath() {
  const homeDir = os.homedir();

  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'claude');
  } else {
    return path.join(homeDir, '.claude');
  }
}

function getCodexConfigPath() {
  // User requested explicit support for ~/.codex
  return path.join(os.homedir(), '.codex');
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (e) {
    return null;
  }
}

function extractTextContent(message) {
  if (!message) return '';

  if (typeof message.content === 'string') return message.content;

  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n\n');
  }

  return '';
}

function extractCodexTextFromContentBlocks(content) {
  if (!content) return '';

  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }

  return '';
}

function tryExtractCwdFromEnvText(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/<cwd>([^<]+)<\/cwd>/);
  return m ? m[1] : null;
}

function isProbablyEnvironmentContextText(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  return t.startsWith('<environment_context>') || t.includes('<environment_context>');
}

function truncateForUi(text, max = 12000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const remaining = text.length - max;
  return `${text.slice(0, max)}\n… [truncated ${remaining} chars]`;
}

function parseStructuredPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = safeJsonParse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function findCommandLikeString(value, depth = 0) {
  if (depth > 4 || value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findCommandLikeString(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const preferredKeys = [
    'cmd',
    'command',
    'shell_command',
    'commandLine',
    'script',
    'patch',
    'query'
  ];

  for (const key of preferredKeys) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return value[key].trim();
    }
  }

  for (const key of Object.keys(value)) {
    const found = findCommandLikeString(value[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function stringifyPayloadForUi(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return truncateForUi(payload);
  try {
    return truncateForUi(JSON.stringify(payload, null, 2));
  } catch (e) {
    return truncateForUi(String(payload));
  }
}

function normalizeToolUse(name, payloadSource, fallbackText = '', callId = null) {
  const payload = parseStructuredPayload(payloadSource);
  const rawPayloadText = typeof payloadSource === 'string' ? payloadSource.trim() : '';
  const rawFallback = typeof fallbackText === 'string' ? fallbackText.trim() : '';

  const command =
    findCommandLikeString(payload) ||
    (rawPayloadText && !parseStructuredPayload(rawPayloadText) ? rawPayloadText : '') ||
    rawFallback;

  let payloadText = '';
  if (payload) {
    payloadText = stringifyPayloadForUi(payload);
  } else if (rawPayloadText && rawPayloadText !== command) {
    payloadText = truncateForUi(rawPayloadText);
  } else if (rawFallback && rawFallback !== command) {
    payloadText = truncateForUi(rawFallback);
  }

  return {
    name: name || 'tool',
    command: truncateForUi(command || '', 4000),
    payload: payloadText,
    callId: callId || null
  };
}

function unwrapCodexRecord(obj) {
  // Codex has at least two observed on-disk formats:
  // 1) Old: { type: "message" | "function_call" | ... }
  // 2) New: { type: "response_item", timestamp, payload: { type: "message" | "function_call" | ... } }
  if (!obj || typeof obj !== 'object') return { timestamp: null, rec: null };
  if (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object') {
    return { timestamp: obj.timestamp || null, rec: obj.payload };
  }
  return { timestamp: obj.timestamp || null, rec: obj };
}

function listFilesRecursive(baseDir, predicate) {
  const results = [];
  if (!fs.existsSync(baseDir)) return results;

  const stack = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile()) {
        if (!predicate || predicate(p)) results.push(p);
      }
    }
  }

  return results;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a1a'
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers for reading session data
ipcMain.handle('get-sessions', async () => {
  try {
    const sessions = [];

    // Claude Code sessions (existing behavior)
    try {
      const configPath = getClaudeConfigPath();
      const historyPath = path.join(configPath, 'history.jsonl');
      const projectsPath = path.join(configPath, 'projects');

      const sessionMap = new Map();

      // Read all session files from projects directory
      if (fs.existsSync(projectsPath)) {
        const projectDirs = fs.readdirSync(projectsPath);

        for (const projectDir of projectDirs) {
          const projectPath = path.join(projectsPath, projectDir);
          let stat;
          try {
            stat = fs.statSync(projectPath);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            const sessionFiles = fs
              .readdirSync(projectPath)
              .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

            for (const sessionFile of sessionFiles) {
              const sessionPath = path.join(projectPath, sessionFile);
              const sessionId = sessionFile.replace('.jsonl', '');

              try {
                const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
                const lines = sessionContent.trim().split('\n').filter(line => line.trim());

                if (lines.length > 0) {
                  const messages = lines.map(line => safeJsonParse(line)).filter(msg => msg !== null);

                  // Find first user message
                  const firstUserMessage = messages.find(msg => msg.type === 'user' && msg.message);

                  if (firstUserMessage) {
                    const projectName = projectDir.replace(/-/g, '/').substring(1); // Remove leading dash and convert dashes to slashes
                    const content = extractTextContent(firstUserMessage.message);

                    sessionMap.set(sessionId, {
                      source: 'claude',
                      id: sessionId,
                      timestamp: new Date(firstUserMessage.timestamp).getTime(),
                      display: content.substring(0, 100),
                      project: projectName,
                      locator: projectDir,
                      messageCount: messages.filter(m => m.type === 'user' || m.type === 'assistant').length
                    });
                  }
                }
              } catch (e) {
                console.error('Error reading session file:', sessionPath, e);
              }
            }
          }
        }
      } else if (fs.existsSync(historyPath) && !fs.existsSync(projectsPath)) {
        // Keep existing error messaging when Claude config exists but projects are missing.
        console.warn('Claude config found but projects directory missing:', projectsPath);
      } else if (!fs.existsSync(historyPath)) {
        // Silently ignore: user may only want Codex sessions.
      }

      sessions.push(...Array.from(sessionMap.values()));
    } catch (e) {
      console.error('Error reading Claude sessions:', e);
    }

    // Codex sessions (new)
    try {
      const codexPath = getCodexConfigPath();
      const sessionsPath = path.join(codexPath, 'sessions');

      const jsonlFiles = listFilesRecursive(sessionsPath, p => p.endsWith('.jsonl'));

      for (const sessionFilePath of jsonlFiles) {
        try {
          const relPath = path.relative(sessionsPath, sessionFilePath);
          if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue;

          const content = fs.readFileSync(sessionFilePath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          if (lines.length === 0) continue;

          const firstObj = safeJsonParse(lines[0]);
          const sessionId =
            (firstObj &&
              typeof firstObj === 'object' &&
              firstObj.type === 'session_meta' &&
              firstObj.payload &&
              typeof firstObj.payload.id === 'string' &&
              firstObj.payload.id) ||
            (firstObj && typeof firstObj.id === 'string' && firstObj.id) ||
            path.basename(sessionFilePath).replace(/\.jsonl$/, '');

          let ts = null;
          const firstTs =
            (firstObj &&
              typeof firstObj === 'object' &&
              firstObj.type === 'session_meta' &&
              firstObj.payload &&
              typeof firstObj.payload.timestamp === 'string' &&
              firstObj.payload.timestamp) ||
            (firstObj && typeof firstObj.timestamp === 'string' && firstObj.timestamp) ||
            null;
          if (firstTs) {
            const t = new Date(firstTs).getTime();
            if (!Number.isNaN(t)) ts = t;
          }

          let cwd = null;
          let displayText = '';
          let messageCount = 0;

          for (const line of lines) {
            const raw = safeJsonParse(line);
            if (!raw || typeof raw !== 'object') continue;

            // session_meta includes cwd directly in the newest format.
            if (!cwd && raw.type === 'session_meta' && raw.payload && typeof raw.payload.cwd === 'string') {
              cwd = raw.payload.cwd;
            }

            const { timestamp: wrapperTs, rec } = unwrapCodexRecord(raw);
            if (!rec || typeof rec !== 'object') continue;

            if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
              messageCount += 1;
            }

            if (!cwd && rec.type === 'message' && rec.role === 'user' && rec.content) {
              const text = extractCodexTextFromContentBlocks(rec.content);
              const extracted = tryExtractCwdFromEnvText(text);
              if (extracted) cwd = extracted;
            }

            if (!displayText && rec.type === 'message' && rec.role === 'user' && rec.content) {
              const text = extractCodexTextFromContentBlocks(rec.content);
              if (text && text.trim() && !isProbablyEnvironmentContextText(text)) {
                displayText = text.trim();
              }
            }

            if (!ts && rec.type === 'message' && rec.role === 'user' && rec.content) {
              // Fallback timestamp: take the wrapper timestamp first (new format), then any explicit fields.
              if (typeof wrapperTs === 'string') {
                const t = new Date(wrapperTs).getTime();
                if (!Number.isNaN(t)) ts = t;
              } else if (typeof rec.created_at === 'string') {
                const t = new Date(rec.created_at).getTime();
                if (!Number.isNaN(t)) ts = t;
              } else if (typeof rec.timestamp === 'string') {
                const t = new Date(rec.timestamp).getTime();
                if (!Number.isNaN(t)) ts = t;
              }
            }
          }

          if (!displayText) {
            // Fallback to any first user message (including env context)
            const firstUser = lines
              .map(l => safeJsonParse(l))
              .map(o => unwrapCodexRecord(o).rec)
              .find(o => o && o.type === 'message' && o.role === 'user' && o.content);
            if (firstUser) {
              displayText = extractCodexTextFromContentBlocks(firstUser.content).trim();
            }
          }

          const project =
            cwd ||
            (firstObj &&
              typeof firstObj === 'object' &&
              firstObj.type === 'session_meta' &&
              firstObj.payload &&
              firstObj.payload.git &&
              (firstObj.payload.git.repository_url || firstObj.payload.git.branch)) ||
            (firstObj && firstObj.git && (firstObj.git.repository_url || firstObj.git.branch)) ||
            'Codex';
          const timestamp = ts || 0;

          sessions.push({
            source: 'codex',
            id: sessionId,
            timestamp,
            display: (displayText || '').substring(0, 100),
            project: project,
            locator: relPath,
            messageCount
          });
        } catch (e) {
          console.error('Error reading Codex session file:', sessionFilePath, e);
        }
      }
    } catch (e) {
      console.error('Error reading Codex sessions:', e);
    }

    // Sort by timestamp (newest first), stable fallback by id.
    sessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || String(a.id).localeCompare(String(b.id)));

    if (sessions.length === 0) {
      const claudeHistory = path.join(getClaudeConfigPath(), 'history.jsonl');
      const codexSessions = path.join(getCodexConfigPath(), 'sessions');
      return { error: `No sessions found. Looked in ${claudeHistory} and ${codexSessions}` };
    }

    return { sessions };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('get-session-details', async (event, sessionId, locator, source) => {
  try {
    if (source === 'codex') {
      const codexPath = getCodexConfigPath();
      const sessionsBase = path.join(codexPath, 'sessions');

      if (typeof locator !== 'string' || !locator.trim()) {
        return { error: 'Invalid Codex session locator' };
      }

      const resolvedBase = path.resolve(sessionsBase);
      const resolvedPath = path.resolve(sessionsBase, locator);
      if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
        return { error: 'Invalid Codex session path' };
      }

      if (!fs.existsSync(resolvedPath)) {
        return { error: 'Session file not found' };
      }

      const sessionContent = fs.readFileSync(resolvedPath, 'utf-8');
      const lines = sessionContent.trim().split('\n').filter(line => line.trim());

      const records = lines.map(line => safeJsonParse(line)).filter(msg => msg !== null);
      // Many Codex records don't include per-message timestamps; fall back to the session header timestamp.
      let defaultTimestamp = null;
      for (const rec of records) {
        if (rec && typeof rec === 'object' && rec.timestamp) {
          defaultTimestamp = rec.timestamp;
          break;
        }
        if (
          rec &&
          typeof rec === 'object' &&
          rec.type === 'session_meta' &&
          rec.payload &&
          typeof rec.payload.timestamp === 'string'
        ) {
          defaultTimestamp = rec.payload.timestamp;
          break;
        }
      }

      const formattedMessages = [];
      let lastAssistantMsg = null;

      for (const raw of records) {
        if (!raw || typeof raw !== 'object') continue;
        const { timestamp: wrapperTs, rec } = unwrapCodexRecord(raw);
        if (!rec || typeof rec !== 'object') continue;

        if (rec.type === 'message' && (rec.role === 'user' || rec.role === 'assistant')) {
          const text = extractCodexTextFromContentBlocks(rec.content);

          const msg = {
            role: rec.role,
            content: text,
            timestamp: rec.timestamp || rec.created_at || wrapperTs || defaultTimestamp || null,
            uuid: rec.id || null,
            toolUses: [],
            fileHistorySnapshots: []
          };

          formattedMessages.push(msg);
          if (rec.role === 'assistant') lastAssistantMsg = msg;
          continue;
        }

        if (rec.type === 'function_call' && typeof rec.name === 'string') {
          if (!lastAssistantMsg) {
            lastAssistantMsg = {
              role: 'assistant',
              content: '',
              timestamp: rec.timestamp || rec.created_at || wrapperTs || defaultTimestamp || null,
              uuid: rec.call_id || rec.id || null,
              toolUses: [],
              fileHistorySnapshots: []
            };
            formattedMessages.push(lastAssistantMsg);
          }
          const payloadSource =
            rec.arguments ??
            rec.input ??
            rec.parameters ??
            rec.args ??
            rec.kwargs ??
            null;
          const fallbackText =
            rec.command ??
            (typeof rec.arguments === 'string' ? rec.arguments : '') ??
            '';

          lastAssistantMsg.toolUses.push(
            normalizeToolUse(rec.name, payloadSource, fallbackText, rec.call_id || rec.id || null)
          );
          continue;
        }
      }

      const cleaned = formattedMessages.filter(msg => {
        if (!msg) return false;
        if (msg.content && String(msg.content).trim()) return true;
        if (msg.toolUses && msg.toolUses.length > 0) return true;
        return false;
      });

      // Hide the first two Codex chat entries (typically bootstrap/system chatter).
      return { messages: cleaned.slice(2) };
    }

    // Default: Claude
    const configPath = getClaudeConfigPath();
    const projectsPath = path.join(configPath, 'projects');
    const sessionPath = path.join(projectsPath, locator, `${sessionId}.jsonl`);

    if (!fs.existsSync(sessionPath)) {
      return { error: 'Session file not found' };
    }

    const sessionContent = fs.readFileSync(sessionPath, 'utf-8');
    const lines = sessionContent.trim().split('\n').filter(line => line.trim());

    const messages = lines.map(line => safeJsonParse(line)).filter(msg => msg !== null);

    // Index file-history snapshots by the message UUID they relate to (messageId).
    const fileHistorySnapshotsByMessageId = new Map();
    for (const msg of messages) {
      if (msg && msg.type === 'file-history-snapshot' && msg.messageId && msg.snapshot) {
        const snapshot = {
          messageId: msg.messageId,
          timestamp: msg.snapshot.timestamp,
          isSnapshotUpdate: !!msg.isSnapshotUpdate,
          trackedFileBackups: msg.snapshot.trackedFileBackups || {}
        };
        const existing = fileHistorySnapshotsByMessageId.get(msg.messageId) || [];
        existing.push(snapshot);
        fileHistorySnapshotsByMessageId.set(msg.messageId, existing);
      }
    }

    // Filter and format messages for display
    const formattedMessages = messages
      .filter(msg => (msg.type === 'user' || msg.type === 'assistant') && msg.message)
      .map(msg => {
        if (msg.type === 'user') {
          const content = extractTextContent(msg.message);

          return {
            role: 'user',
            content: content,
            timestamp: msg.timestamp,
            uuid: msg.uuid,
            fileHistorySnapshots: fileHistorySnapshotsByMessageId.get(msg.uuid) || []
          };
        } else if (msg.type === 'assistant') {
          const content = extractTextContent(msg.message);

          return {
            role: 'assistant',
            content: content,
            timestamp: msg.timestamp,
            uuid: msg.uuid,
            toolUses:
              msg.message.content
                ?.filter(block => block.type === 'tool_use')
                .map(block =>
                  normalizeToolUse(
                    block.name,
                    block.input ?? block.arguments ?? block.parameters ?? null,
                    typeof block.input === 'string' ? block.input : '',
                    block.id || null
                  )
                ) || [],
            fileHistorySnapshots: fileHistorySnapshotsByMessageId.get(msg.uuid) || []
          };
        }
        return null;
      })
      .filter(msg => {
        if (!msg) return false;
        if (msg.content && msg.content.trim()) return true;
        if (msg.toolUses && msg.toolUses.length > 0) return true;
        if (msg.fileHistorySnapshots && msg.fileHistorySnapshots.length > 0) return true;
        return false;
      });

    return { messages: formattedMessages };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('get-file-history-file', async (event, sessionId, backupFileName) => {
  try {
    const configPath = getClaudeConfigPath();
    const baseDir = path.join(configPath, 'file-history');

    if (
      typeof sessionId !== 'string' ||
      typeof backupFileName !== 'string' ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      backupFileName.includes('/') ||
      backupFileName.includes('\\') ||
      sessionId.includes('..') ||
      backupFileName.includes('..')
    ) {
      return { error: 'Invalid file-history request' };
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedPath = path.resolve(baseDir, sessionId, backupFileName);
    if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
      return { error: 'Invalid file-history path' };
    }

    if (!fs.existsSync(resolvedPath)) {
      return { error: 'Snapshot file not found' };
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return { error: 'Snapshot path is not a file' };
    }

    // Avoid locking the renderer with extremely large files.
    const maxBytes = 2 * 1024 * 1024; // 2 MiB
    if (stat.size > maxBytes) {
      const fd = fs.openSync(resolvedPath, 'r');
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
        return {
          content: buffer.slice(0, bytesRead).toString('utf-8'),
          truncated: true,
          originalBytes: stat.size
        };
      } finally {
        fs.closeSync(fd);
      }
    }

    return { content: fs.readFileSync(resolvedPath, 'utf-8') };
  } catch (error) {
    return { error: error.message };
  }
});
