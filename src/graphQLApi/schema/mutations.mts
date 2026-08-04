import { GraphQLObjectType } from 'graphql'

import { logout } from './mutations/logout.mjs'

const MutationsApi = new GraphQLObjectType({
	name: 'MutationsApi',
	fields: {
		logout
	}
})

export default MutationsApi
