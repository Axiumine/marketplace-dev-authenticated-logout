import { graphql, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { beforeAll, describe, expect, it } from 'vitest'

// Imported inside beforeAll, not at module top level: a module-level mutant (the
// `description` literal below) changes value during ESM evaluation. Importing at
// file scope runs that evaluation during Vitest's collection phase, before any
// test is active, so Stryker cannot attribute the kill to a test and reports the
// mutant as Survived even though the suite would plainly fail. Deferring the
// import to beforeAll makes the evaluation happen while a test is running.
let helloLogout: (typeof import('../src/graphQLApi/schema/queries/helloLogout.mts'))['helloLogout']
let Hello2Type: (typeof import('../src/graphQLApi/schema/types/Hello2Type.mts'))['default']

beforeAll(async () => {
	;({ helloLogout } = await import('../src/graphQLApi/schema/queries/helloLogout.mts'))
	;({ default: Hello2Type } = await import('../src/graphQLApi/schema/types/Hello2Type.mts'))
})

describe('Hello2Type', () => {
	it('exposes only the txt field, a non-nullable String', () => {
		const fields = Hello2Type.getFields()

		expect(Hello2Type.name).toBe('Hello2Type')
		expect(Object.keys(fields)).toEqual(['txt'])
		expect(fields.txt.type).toBeInstanceOf(GraphQLNonNull)
		expect((fields.txt.type as GraphQLNonNull<typeof GraphQLString>).ofType).toBe(GraphQLString)
	})
})

describe('queries.helloLogout', () => {
	it('is of non-nullable Hello2Type', () => {
		expect(helloLogout.type).toBeInstanceOf(GraphQLNonNull)
		expect((helloLogout.type as GraphQLNonNull<GraphQLObjectType>).ofType).toBe(Hello2Type)
	})

	it('describes itself as "helloLogout"', () => {
		expect(helloLogout.description).toBe('helloLogout')
	})

	it('resolves the greeting text', async () => {
		await expect(helloLogout.resolve()).resolves.toEqual({ txt: 'Hello from helloLogout' })
	})
})

describe('QueriesApi', () => {
	// Imported fresh inside each test, not via the shared beforeAll above: the
	// `name: 'QueriesApi'` literal and the object literal it lives in are
	// asserted eagerly by graphql-js (assertName) the moment GraphQLObjectType is
	// constructed, so a mutant that blanks either one makes THIS import throw.
	// Sharing that import with other tests via a beforeAll would turn the throw
	// into a hook failure — Vitest marks every test in the hook's scope "skipped",
	// not "failed", and Stryker only counts a "failed" test as a kill. An import
	// inside the test body fails only that test, which Stryker does attribute.
	it('mounts helloLogout as its only field', async () => {
		const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')

		expect(QueriesApi.name).toBe('QueriesApi')
		expect(Object.keys(QueriesApi.getFields())).toEqual(['helloLogout'])
	})

	it('runs the query end-to-end', async () => {
		const { default: QueriesApi } = await import('../src/graphQLApi/schema/queries.mts')

		const result = await graphql({
			schema: new GraphQLSchema({ query: QueriesApi }),
			source: '{ helloLogout { txt } }'
		})

		expect(result.errors).toBeUndefined()
		expect(result.data).toEqual({ helloLogout: { txt: 'Hello from helloLogout' } })
	})
})
