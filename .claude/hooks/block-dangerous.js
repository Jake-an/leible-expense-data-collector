#!/usr/bin/env node
/* eslint-disable */
// PreToolUse hook: blocks Bash tool calls matching dangerous shell patterns.
// Reads JSON tool-call payload from stdin, greps the command field.
// Exit codes:
//   0 = allow (normal flow)
//   2 = block (Claude Code refuses the tool call, agent sees stderr)
//
// Extend DANGEROUS below as new attack patterns surface.
// Test manually:
//   echo '{"tool_input":{"command":"rm -rf /"}}' | node .claude/hooks/block-dangerous.js
//   (expect: BLOCKED line on stderr, exit 2)

const fs = require('fs');

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  // Malformed input — don't block, let Claude Code handle it
  process.exit(0);
}

const cmd = String((input && input.tool_input && input.tool_input.command) || '');
if (!cmd) process.exit(0);

const DANGEROUS = [
  { name: 'rm -rf on absolute path',    re: /\brm\s+-rf?\s+\/(?!tmp\b)/i },
  { name: 'sudo escalation',            re: /\bsudo\b/i },
  { name: 'curl | sh remote execution', re: /curl[^|]*\|\s*(sh|bash|zsh)/i },
  { name: 'wget | sh remote execution', re: /wget[^|]*\|\s*(sh|bash|zsh)/i },
  { name: 'chmod 777 permission wipe',  re: /\bchmod\s+-?R?\s*777\b/i },
  { name: 'dd disk write',              re: /\bdd\s+if=/i },
  { name: 'mkfs filesystem format',     re: /\bmkfs\b/i },
  { name: 'fork bomb',                  re: /:\s*\(\s*\)\s*\{/ },
  { name: 'eval of arbitrary input',    re: /\beval\s+(\$|`|"\$)/i },
  { name: 'base64 | sh obfuscation',    re: /\bbase64\s+-d\s*\|\s*(sh|bash|zsh)/i },
  // Force-push is banned outright in this repo (teammate safety). Match the flag
  // ANYWHERE in the push command — flag-before-ref, flag-after-ref, and bare
  // `git push -f` all count. This closes the position-dependent gap the phase-0
  // review flagged (git push origin main --force / git push -f slipped past).
  { name: 'git force-push (banned in this repo)', re: /git\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)(?=\s|$)/i },
  { name: 'git reset --hard (discards work)',      re: /git\s+reset\s+--hard\b/i },
  { name: 'SQL DROP TABLE/DATABASE',               re: /\bDROP\s+(TABLE|DATABASE)\b/i },
  { name: 'shutdown / halt / reboot',   re: /\b(shutdown|halt|reboot|poweroff)\b/i },
  { name: 'read .clasprc.json secrets', re: /\.clasprc\.json/i },
  { name: 'read .ssh private keys',     re: /\.ssh\/(id_rsa|id_ed25519|id_ecdsa)/i },
  { name: 'read AWS credentials',       re: /\.aws\/credentials/i },
];

for (const { name, re } of DANGEROUS) {
  if (re.test(cmd)) {
    process.stderr.write(
      'BLOCKED by PreToolUse hook (block-dangerous.js)\n' +
      'Reason: ' + name + '\n' +
      'Pattern: ' + re + '\n' +
      'Command: ' + cmd + '\n'
    );
    process.exit(2);
  }
}

process.exit(0);
