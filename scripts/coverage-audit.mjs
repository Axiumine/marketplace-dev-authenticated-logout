#!/usr/bin/env node
//
// The file-count gate. `yarn test:cov` runs it straight after vitest, and it answers the one
// question a coverage percentage cannot: **is every source file this repo ships actually in the
// report the percentage was computed over?**
//
// ⚠️ A threshold of 100% says nothing about a file that is not in the denominator. Two ways a file
// leaves it:
//
//   1. No `coverage.include`. The v8 provider then reports only what a test `import`-ed, so a file
//      no suite loads is ABSENT rather than listed at 0% (RISK_REGISTER R07). Every package here
//      now sets `include`, and this script fails loudly if one stops.
//   2. A `coverage.exclude` glob. `src/gql/**` is a directory, so it exempts whatever is dropped
//      into that directory next — silently, with the run still green. `include` cannot catch this
//      one, which is why this script exists.
//   3. ⚠️ An extension `coverage.include` never matched (RISK_REGISTER R56), and this is the quiet
//      one: `include` decides BOTH sides of the comparison in 1, so a `.js` dropped into an app's
//      `src/`, or an `.mjs` beside a service's `.mts`, is absent from the report AND absent from the
//      list this script compares the report against. Nothing anywhere goes red. So the roots of the
//      globs are read as well as the globs — everything before a pattern's first wildcard segment is
//      the directory the package declared to be its source — and every tracked file under one of
//      those roots that no glob matches has to be in coverage-exempt.txt by name.
//
// The rule it enforces: the set of tracked files under a declared source root that the report does
// not account for — matched by `coverage.include` and absent from coverage/lcov.info, or matched by
// no glob at all — must equal coverage-exempt.txt **exactly**. Both directions fail —
// an unnamed exemption is a hole, and a named file that is now covered is a stale line that would
// hide the next hole. Exemptions are exact paths, never globs: a glob here would re-create the
// blind spot the file exists to close.
//
// It reads. It never writes and never runs a test; `vitest run --coverage` has to have run first,
// and `test:cov` in package.json is what guarantees that.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const EXEMPT_FILE = 'coverage-exempt.txt'
const CONFIGS = ['vitest.config.mts', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.js']

const die = (...lines) => {
	console.error('\n✗ coverage-audit: ' + lines.join('\n  '))
	process.exit(1)
}

// Strip comments before any parsing. Done with a quote-aware scan rather than a regex: the glob
// patterns we are about to read are full of `/` and `*`, and a naive `//` strip mangles them.
const stripComments = (src) => {
	let out = ''
	let quote = null
	for (let i = 0; i < src.length; i++) {
		const c = src[i]
		if (quote) {
			out += c
			if (c === '\\') {
				out += src[++i] ?? ''
			} else if (c === quote) {
				quote = null
			}
			continue
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c
			out += c
			continue
		}
		if (c === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++
			out += '\n'
			continue
		}
		if (c === '/' && src[i + 1] === '*') {
			i += 2
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
			i++
			continue
		}
		out += c
	}
	return out
}

// Read one string-array property out of the `coverage` block. Anchored on `coverage:` so the
// `include` that names the TEST files never answers for the one that names the SOURCE files.
const coverageArray = (src, key) => {
	const block = src.slice(src.search(/\bcoverage\s*:\s*\{/))
	// Lazy `[\s\S]*?` up to the first `]`, and that closing `]` is deliberately NOT escaped:
	// outside a character class the escape is redundant, and Qodana's RegExpRedundantEscape is a
	// High that fails the commit over it. The opening `\\[` does have to stay escaped.
	const m = block.match(new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)]`))
	if (!m) return null
	return [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((s) => s[1] ?? s[2])
}

const coverageString = (src, key) => {
	const block = src.slice(src.search(/\bcoverage\s*:\s*\{/))
	const m = block.match(new RegExp(`\\b${key}\\s*:\\s*'([^']*)'|\\b${key}\\s*:\\s*"([^"]*)"`))
	return m ? (m[1] ?? m[2]) : null
}

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Enough glob for the patterns these fifteen configs actually use: `**`, `*`, `?` and `{a,b}`.
// `**/` matches zero directories too, so `src/**/*.mts` covers `src/index.mts`.
const globToRegExp = (glob) => {
	let re = '^'
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]
		if (c === '*') {
			if (glob[i + 1] === '*') {
				if (glob[i + 2] === '/') {
					re += '(?:[^/]+/)*'
					i += 2
				} else {
					re += '.*'
					i += 1
				}
			} else {
				re += '[^/]*'
			}
		} else if (c === '?') {
			re += '[^/]'
		} else if (c === '{') {
			const end = glob.indexOf('}', i)
			if (end === -1) die(`unclosed { in coverage.include pattern "${glob}"`)
			re +=
				'(?:' +
				glob
					.slice(i + 1, end)
					.split(',')
					.map(escapeRe)
					.join('|') +
				')'
			i = end
		} else {
			re += escapeRe(c)
		}
	}
	return new RegExp(re + '$')
}

// The directory a glob declares to be source: every segment before the first one holding a wildcard.
// `src/**/*.mts` → `src`, `lib/**/*.js` → `lib`. A pattern with no wildcard anywhere is one exact
// file rather than a directory of them — `migrate-mongo-config.js` is one — and names no root, since
// an exact path cannot drift.
const globRoot = (glob) => {
	const segments = glob.split('/')
	const literal = []
	for (const segment of segments) {
		if (/[*?{]/.test(segment)) break
		literal.push(segment)
	}
	return literal.length === segments.length ? null : literal.join('/')
}

const configPath = CONFIGS.find((f) => existsSync(f))
if (!configPath) die(`no vitest config found (looked for ${CONFIGS.join(', ')})`)

const config = stripComments(readFileSync(configPath, 'utf8'))

const include = coverageArray(config, 'include')
if (!include || include.length === 0) {
	die(
		`${configPath} sets no coverage.include.`,
		'Without it the v8 provider reports only the files a test imported, so a source file no',
		'suite loads is absent from the report rather than listed at 0% — and the 100% threshold',
		'passes over it. This is RISK_REGISTER R07. Add coverage.include naming every source file.'
	)
}

const reportsDirectory = coverageString(config, 'reportsDirectory') ?? 'coverage'
const lcovPath = join(reportsDirectory, 'lcov.info')
if (!existsSync(lcovPath)) {
	die(`${lcovPath} is missing — run \`yarn test:cov\`, which produces it before calling this script.`)
}

const matchers = include.map(globToRegExp)
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const gated = tracked.filter((f) => matchers.some((re) => re.test(f)))
if (gated.length === 0) {
	die(`coverage.include (${include.join(', ')}) matches no tracked file — the globs are wrong.`)
}

// ⚠️ The files `include` cannot report on because it never reached them (R56). Read from the same
// globs, so a root that moves takes this scan with it and cannot be forgotten separately.
const roots = [...new Set(include.map(globRoot).filter(Boolean))]
const drifted = tracked.filter((f) => roots.some((r) => f.startsWith(`${r}/`)) && !matchers.some((re) => re.test(f)))

const reported = new Set(
	readFileSync(lcovPath, 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('SF:'))
		.map((l) => l.slice(3).trim())
)

const exempt = existsSync(EXEMPT_FILE)
	? readFileSync(EXEMPT_FILE, 'utf8')
			.split('\n')
			.map((l) => l.replace(/#.*/, '').trim())
			.filter(Boolean)
	: []

for (const path of exempt) {
	if (path.includes('*')) {
		die(
			`${EXEMPT_FILE} line "${path}" is a glob.`,
			'Exemptions are exact paths. A glob exempts the next file dropped beside this one,',
			'which is the failure this gate exists to catch.'
		)
	}
}

// One set, two reasons: gated and unreported, or under a source root and gated by nothing. Both are
// holes in the denominator, both are named in the same file, and both go stale the same way.
const missing = [...new Set([...gated.filter((f) => !reported.has(f)), ...drifted])].sort()
const exemptSet = new Set(exempt)
const undeclared = missing.filter((f) => !exemptSet.has(f))
const stale = exempt.filter((f) => !missing.includes(f)).sort()

if (undeclared.length) {
	const driftSet = new Set(drifted)
	console.error(
		`\n✗ coverage-audit: ${undeclared.length} tracked file(s) under a source root that ${lcovPath} does not account for:`
	)
	for (const f of undeclared) {
		console.error(`    ${f}${driftSet.has(f) ? '   ← no coverage.include glob matches it' : ''}`)
	}
	console.error(
		'\n  A file that is not in the report is not in the denominator, so the 100% threshold said',
		'\n  nothing about it. Either give it a test — adding its extension to coverage.include if that',
		`\n  is what it is missing — or name it in ${EXEMPT_FILE} with the reason it can never have one.`,
		'\n  Do not widen a coverage.exclude glob, and do not shorten a source root, to make this pass.'
	)
	process.exitCode = 1
}

if (stale.length) {
	console.error(`\n✗ coverage-audit: ${stale.length} line(s) in ${EXEMPT_FILE} exempt a file that is covered or gone:`)
	for (const f of stale) console.error(`    ${f}`)
	console.error('\n  Delete them. A stale exemption is a hole waiting for a file of that name to come back.')
	process.exitCode = 1
}

if (!process.exitCode) {
	console.log(
		`✓ coverage-audit: ${gated.length} tracked source file(s) gated, ${reported.size} in the report, ` +
			`${exempt.length} exempt by name, ${drifted.length} under ${roots.length} source root(s) with no glob.`
	)
}
