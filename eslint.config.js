import eslintConfig from '@axiumine/eslint-config-be'
import js from '@eslint/js'
import tsParser from '@typescript-eslint/parser'
import simpleImportSort from 'eslint-plugin-simple-import-sort'

// The shared config only covers `src/**`, so the test files and the vitest configs
// (outside src/) would be left without a TS parser. Here we reuse the same rules as the shared
// TypeScript block, but without `project`: tsconfig.json only includes `src/**/*.mts`.
const sharedTsBlock = eslintConfig.find((c) => c.files?.includes('src/**/*.{d.ts,ts,cts,mts}'))

/*
 * E01-S15. The pair ADR-034 replaced, refused by name so that "nothing reads them" stops being a claim
 * about how the code happens to be written today. The signing keys are one Redis record wrapped under
 * KEYGRIP_KEK; a service that read KEYGRIP_KEY_1 out of its environment again would sign cookies with a
 * key its siblings do not have, and the failure is a browser that is silently logged out rather than an
 * error anybody sees.
 *
 * Two selectors because `process.env.X` parses as an Identifier and `process.env['X']` as a Literal —
 * the same reason the NODE_TLS_REJECT_UNAUTHORIZED pair above carries two. Both are anchored on
 * `process.env` rather than on the bare name: KEYGRIP_KEY_BYTES is a live constant in
 * marketplace-common, and a rule matching the prefix everywhere would refuse it.
 *
 * Scoped to `src/**` where it is used below: test/index.unit.test.mts asserts these very names are
 * absent from REQUIRED_ENV_VARS, and a repo-wide ban would refuse the test that proves the story.
 */
const KEYGRIP_KEY_NO_ENV_READ = [
	{
		selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^KEYGRIP_KEY_/]",
		message:
			'E01-S15: KEYGRIP_KEY_1/KEYGRIP_KEY_2 are gone since ADR-034. The cookie-signing keys are the Redis record at <REDIS_KEY>keygrip, unwrapped with KEYGRIP_KEK by loadKeygrip in marketplace-common — an env read here signs cookies the other services cannot verify.'
	},
	{
		selector: "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/^KEYGRIP_KEY_/]",
		message:
			'E01-S15: KEYGRIP_KEY_1/KEYGRIP_KEY_2 are gone since ADR-034. The cookie-signing keys are the Redis record at <REDIS_KEY>keygrip, unwrapped with KEYGRIP_KEK by loadKeygrip in marketplace-common — an env read here signs cookies the other services cannot verify.'
	}
]

/* Hoisted so both config objects below can share it — see the note above the second one. */
const RESTRICTED_SYNTAX = [
	{
		selector: "AssignmentExpression[left.property.name='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.value='rejectUnauthorized']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Property[key.name='sendDefaultPii']",
		message:
			'E12-S04: the blanket Sentry PII flag is absent by decision, not set to false. Name the individual dataCollection categories instead — the observability section of docs/architecture.md says which, and why.'
	},
	// E12-S21 / E12-S22. Two settings one word from being reversed, with nothing else that would
	// notice. `!=` rather than a positive match because the shape to refuse is *any other
	// value*, including the `'medium'` the SDK falls back to when the key is dropped entirely —
	// and the pair selector uses `:has(> …)` so that an unrelated nested object carrying a
	// `beforeSend` cannot satisfy it on the outer literal's behalf.
	{
		selector: "Property[key.name='maxIncomingRequestBodySize'][value.value!='none']",
		message:
			"E12-S21: the request body is never captured. `maxIncomingRequestBodySize: 'none'` is the only gate on it — `dataCollection.httpBodies` reaches the span attribute and not the event, which is how a plaintext password was measured on the wire."
	},
	{
		selector: "ObjectExpression:has(> Property[key.name='beforeSend']):not(:has(> Property[key.name='beforeSendTransaction']))",
		message:
			'E12-S22: `beforeSend` and `beforeSendTransaction` are wired together or not at all. The SDK routes transaction events to the second hook only, and the client address is on the transaction — one hook without the other means a `tracesSampleRate` switches the redaction off.'
	},
	{
		selector: "MemberExpression[property.name='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	},
	{
		selector: "Literal[value='NODE_TLS_REJECT_UNAUTHORIZED']",
		message:
			'E12-S04: certificate verification stays on. Trust the collector CA from outside the process — NODE_EXTRA_CA_CERTS=/path/to/ca.pem — as the parent workspace SETUP.md §7 describes.'
	}
]

export default [
	// `.stryker-tmp/**` and `reports/**` are build output, not sources. Stryker copies the whole
	// repo into a sandbox under .stryker-tmp and only removes it on a clean exit — an interrupted
	// run leaves one behind, and eslint then lints a second copy of every test file. Those copies
	// carry `@ts-nocheck` and sit outside every tsconfig, so the lint fails with dozens of errors
	// that point at a directory .gitignore already ignores.
	// `.qodana/**` is what `--results-dir` writes: a SARIF file and a bundled HTML report whose
	// minified browser JS is someone else's code. The root-JS block at the bottom of this file is
	// scoped tightly enough that none of it is reachable anyway — this entry is the second lock.
	{ ignores: ['dist/**', 'coverage/**', '.stryker-tmp/**', 'reports/**', '.qodana/**'] },
	...eslintConfig,
	{
		files: ['test/**/*.mts', 'vitest.*.mts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
		},
		plugins: sharedTsBlock.plugins,
		rules: sharedTsBlock.rules
	},
	// The root-level JS config files — this file and stryker.config.mjs. The shared config's JS block
	// is scoped to `src/**/*.{js,cjs,mjs}`, and a service whose sources are all .mts has no JS under
	// src/ at all, so without this block the two files that decide how everything else is linted and
	// mutated are themselves checked by nothing while `yarn lint:check` reports green.
	//
	// `marketplace-dev-public-resource` was the only repo that noticed: it carried a `.eslintrc.json`
	// declaring exactly this intent — eslint:recommended plus simple-import-sort, node, `*.mjs` as
	// module — and it never once ran. eslintrc was already inert under eslint 9's flat-config default,
	// and eslint 10 (`^10.8.0` here) dropped the format outright, so the file was decoration. It is
	// deleted; this block is what it meant to be, and it lives in all seven services and in
	// marketplace-common because the gap was never specific to the one repo that documented it.
	//
	// `*.js` in flat config matches the config file's own directory only — it is NOT expanded to
	// `**/*.js`. That is the whole reason this is safe: a repo-wide JS block would also pick up the
	// minified browser bundle Qodana writes under .qodana/ and any leftover .stryker-tmp/ sandbox,
	// which is precisely how marketplace-admin's config arrived at 1600 `no-undef` errors. Both paths are
	// in the `ignores` above as well — belt and braces, since the glob alone already excludes them.
	//
	// No `globals` entry: neither root file references a node global. Every `process` and `module`
	// that greps out of stryker.config.mjs across these repos is inside a comment. Add one here if
	// that stops being true — do not reach for a wider glob.
	{
		files: ['*.js', '*.mjs', '*.cjs'],
		languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
		plugins: { 'simple-import-sort': simpleImportSort },
		rules: {
			...js.configs.recommended.rules,
			'simple-import-sort/imports': 'error',
			'simple-import-sort/exports': 'error'
		}
	},
	// E12-S04 — neither setting this audit removed can come back by accident.
	//
	// Core `no-restricted-syntax`, in this file rather than in `@axiumine/eslint-config-be`: the shared
	// package is a repo outside these sixteen and ships to unrelated consumers, so a Sentry-specific rule
	// there would cost a publish, a version bump in ten dependents, and a rule everyone else carries for
	// nothing. One block duplicated into ten repos is the cheaper half of that trade, and it follows the
	// idiom the two blocks above already established.
	//
	// No `files` key, so this applies to every file eslint looks at here. Three selectors for
	// `rejectUnauthorized` because the defect actually in the tree was an assignment
	// (`options.rejectUnauthorized = false`), not an object literal — a `Property`-only rule passes the
	// exact code it exists to catch — and the computed form has a `key.value` where the plain one has a
	// `key.name`. Two for `NODE_TLS_REJECT_UNAUTHORIZED` for the same reason one level up:
	// `process.env.X` parses as an Identifier, `process.env['X']` as a Literal, and a rule carrying one
	// misses the other.
	{
		rules: {
			'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX]
		}
	},
	// The keygrip ban rides on top of the shared entries rather than replacing them: a second config
	// object naming the same rule discards the first one's options for every file it matches, so
	// dropping the spread would silently un-ban every Sentry and TLS selector inside src/**.
	{
		files: ['src/**/*.mts'],
		rules: {
			'no-restricted-syntax': ['error', ...RESTRICTED_SYNTAX, ...KEYGRIP_KEY_NO_ENV_READ]
		}
	}
]
