import { GraphQLObjectType } from 'graphql'

import { helloLogout } from './queries/helloLogout.mjs'

const QueriesApi = new GraphQLObjectType({
	name: 'QueriesApi',
	fields: {
		helloLogout
	}
})

export default QueriesApi
