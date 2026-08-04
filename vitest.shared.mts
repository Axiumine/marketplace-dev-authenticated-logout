import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

// tsconfig path aliases used by the sources (kept in sync with tsconfig.json "paths").
const aliases: Array<[string, string]> = [
	['@lib/', 'src/lib/'],
	['@ptypes/', 'src/graphQLApi/schema/types/']
]

function toAbs(source: string, importer?: string): string | null {
	for (const [prefix, dir] of aliases) {
		if (source.startsWith(prefix)) return path.join(root, dir, source.slice(prefix.length))
	}
	if ((source.startsWith('./') || source.startsWith('../')) && importer) {
		return path.resolve(path.dirname(importer.split('?')[0]), source)
	}
	return null
}

// The sources are NodeNext `.mts` that import each other with `.mjs` specifiers (and `@`-aliases).
// Vite has no built-in `.mjs -> .mts` rewrite, so map every alias/relative specifier to the real file.
export const nodeNextResolver = {
	name: 'nodenext-mts-resolver',
	enforce: 'pre' as const,
	resolveId(source: string, importer?: string) {
		const abs = toAbs(source, importer)
		if (!abs) return null // bare specifiers (koa, graphql, @axiumine/*) -> default resolver
		if (abs.endsWith('.mjs')) {
			const mts = `${abs.slice(0, -4)}.mts`
			if (existsSync(mts)) return mts
		}
		return existsSync(abs) ? abs : null
	}
}
