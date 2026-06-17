#!/usr/bin/env node
/* eslint-disable */
// Stop hook: final session-end audit.
// Scans project files for leaked secrets before the session closes.
// Exit code is always 0 — the hook warns but never blocks session end.
//
// Extend SECRET_PATTERNS as new secret formats need to be caught.

const fs = require('fs');
const path = require('path');

const SECRET_PATTERNS = [
  { name: 'Anthropic API key',       re: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
  { name: 'AWS access key ID',       re: /AKIA[0-9A-Z]{16}/ },
  { name: 'Google OAuth token',      re: /ya29\.[a-zA-Z0-9_-]{20,}/ },
  { name: 'GitHub personal token',   re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'Slack token',             re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Private key header',      re: /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'Google API key',          re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Square access token',     re: /\b(EAAA|sq0atp-)[A-Za-z0-9_-]{20,}/ },
];

const SCAN_EXTS  = new Set(['.js', '.gs', '.py', '.html', '.json', '.md', '.env']);
const SKIP_DIRS  = new Set(['node_modules', '.git', '.claude', 'downloads', 'sessions', '.venv', '__pycache__']);
const MAX_DEPTH  = 4;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files > 2MB

function scanDir(dir, findings, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full, findings, depth + 1);
      continue;
    }
    if (!SCAN_EXTS.has(path.extname(entry.name))) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(full, 'utf8');
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(content)) {
          findings.push({ file: full, name });
        }
      }
    } catch {
      // unreadable, skip
    }
  }
}

const findings = [];
scanDir(process.cwd(), findings, 0);

if (findings.length > 0) {
  process.stderr.write('[Stop hook] Possible secrets detected in project files:\n');
  for (const { file, name } of findings) {
    process.stderr.write('  ' + file + ' -- ' + name + '\n');
  }
  process.stderr.write('Review before committing or sharing.\n');
}

process.exit(0);
