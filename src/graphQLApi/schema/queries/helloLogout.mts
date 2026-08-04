import Hello2Type from '@ptypes/Hello2Type.mjs'
import { GraphQLNonNull } from 'graphql'

export const helloLogout = {
	description: 'helloLogout',
	type: new GraphQLNonNull(Hello2Type),
	async resolve() {
		return {
			txt: `Hello from helloLogout`
		}
	}
}
