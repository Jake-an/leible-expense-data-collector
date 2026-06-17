#!/usr/bin/env node
/* eslint-disable */
// SessionStart hook: keep local main in sync with origin without clobbering work.
// Fetches origin/main; fast-forwards only when the working tree is clean and
// local has not diverged. Never blocks the session (always exits 0).

const { execSync } = require('child_process');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

try {
  run('git fetch origin main --quiet');

  const behind = parseInt(run('git rev-list --count HEAD..origin/main'), 10);
  if (behind === 0) process.exit(0); // already up-to-date — stay silent

  const dirty = run('git status --porcelain');
  const ahead = parseInt(run('git rev-list --count origin/main..HEAD'), 10);

  if (ahead > 0) {
    console.log(`⚠️  Local and origin/main have diverged (you: +${ahead}, remote: +${behind}). Resolve manually before editing.`);
    process.exit(0);
  }

  if (dirty) {
    console.log(`⚠️  origin/main has ${behind} new commit${behind > 1 ? 's' : ''} but your working tree has uncommitted changes. Stash or commit first, then pull.`);
    process.exit(0);
  }

  run('git pull --ff-only origin main');
  console.log(`Pulled ${behind} commit${behind > 1 ? 's' : ''} from origin/main.`);
} catch (err) {
  // Non-fatal — don't block the session
  console.error('sync-from-remote: fetch failed —', err.message.split('\n')[0]);
}
