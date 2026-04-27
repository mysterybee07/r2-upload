#!/usr/bin/env node
// Pre-commit secret scanner. Blocks the commit if a staged file looks like it contains
// real credentials. Designed to catch the common case of pasting a key into .env.example
// or hardcoding one into source.

import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function stagedFiles() {
  try {
    return execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

const SKIP_FILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /(^|\/)dist\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.git\//,
  // The scanner itself contains regex matching secret-shaped strings.
  /(^|\/)scripts\/check-secrets\.mjs$/,
]

const SECRET_KEY_NAMES = [
  'R2_SECRET_ACCESS_KEY',
  'R2_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_API_KEY',
  'GITHUB_TOKEN',
  'DATABASE_URL',
  'MONGODB_URI',
  'JWT_SECRET',
  'SECRET_KEY',
  'PRIVATE_KEY',
  'PASSWORD',
]

const ASSIGNMENT_RE = new RegExp(
  String.raw`\b(` +
    SECRET_KEY_NAMES.join('|') +
    String.raw`)\s*[=:]\s*['"]?([^\s'"]+)['"]?`,
  'i',
)

function isPlaceholder(value) {
  if (!value) return true
  if (value.length < 8) return true
  const v = value.toLowerCase()
  return (
    v.startsWith('your-') ||
    v.startsWith('your_') ||
    v.includes('example') ||
    v.includes('placeholder') ||
    v.includes('changeme') ||
    /^x+$/.test(v) ||
    /^<.+>$/.test(v)
  )
}

const violations = []

for (const file of stagedFiles()) {
  if (SKIP_FILE_PATTERNS.some((re) => re.test(file))) continue

  const base = path.basename(file)

  // 1. Block any committed env file other than .env.example
  if (/^\.env(\..+)?$/.test(base)) {
    if (base !== '.env.example') {
      violations.push({
        file,
        line: 0,
        msg: `env files must never be committed (use .env.local locally and Vercel env vars in production)`,
      })
      continue
    }
    // For .env.example: allow only empty values
    let content = ''
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = content.split('\n')
    lines.forEach((line, i) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return
      const eq = trimmed.indexOf('=')
      if (eq === -1) return
      const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (value && !isPlaceholder(value)) {
        violations.push({
          file,
          line: i + 1,
          msg: `.env.example must not contain real values — keep keys with empty values`,
        })
      }
    })
    continue
  }

  // 2. Scan source/config files for hardcoded credentials
  let content
  try {
    const st = statSync(file)
    if (st.size > 1_000_000) continue
    content = readFileSync(file, 'utf8')
  } catch {
    continue // binary or unreadable
  }

  content.split('\n').forEach((line, i) => {
    const m = line.match(ASSIGNMENT_RE)
    if (!m) return
    const [, name, value] = m
    if (isPlaceholder(value)) return
    violations.push({
      file,
      line: i + 1,
      msg: `looks like a real credential assignment: ${name}`,
    })
  })
}

if (violations.length === 0) {
  process.exit(0)
}

console.error(`${RED}✗ Pre-commit secret check failed${RESET}\n`)
for (const v of violations) {
  const loc = v.line ? `${v.file}:${v.line}` : v.file
  console.error(`  ${RED}${loc}${RESET}  ${v.msg}`)
}
console.error(
  `\n${YELLOW}If this is genuinely a false positive, bypass with:${RESET} ${DIM}git commit --no-verify${RESET}`,
)
console.error(
  `${YELLOW}Otherwise: move the value to .env.local, rotate the key if it has been exposed, and re-commit.${RESET}`,
)
process.exit(1)
