import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql'

const Hello2Type = new GraphQLObjectType({
	name: 'Hello2Type',
	fields: () => ({
		txt: { type: new GraphQLNonNull(GraphQLString) }
	})
})

export default Hello2Type
