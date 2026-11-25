import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each module below loads the dotenv file itself, so that it reads a configured environment whichever
// module a process imports first. Who asked is read off the caller's stack frame: what a module imports
// loads it too, so "config was called" alone would stay true with the module's own call gone.
const callers = vi.hoisted((): string[] => [])

vi.mock('dotenv', () => {
  const config = () => {
    // Line 0 is the message, line 1 this function, line 2 whoever called it.
    callers.push(new Error().stack?.split('\n')[2] ?? '')
    return { parsed: {} }
  }
  return { config, default: { config } }
})
vi.mock('@axiumine/koa-utils/dataSources/Redis', () => ({ redisClient: {} }))

describe('the modules that read the environment', () => {
  beforeEach(() => {
    vi.resetModules()
    callers.length = 0
  })

  // Imported inside the test: a mutant is switched on per test, and a module already in the registry
  // is never evaluated again.
  it.each([
    ['src/graphQLApi/schema/mutations/logout.mts', () => import('../src/graphQLApi/schema/mutations/logout.mts')],
    ['src/lib/authorizationLogoutHandler.mts', () => import('../src/lib/authorizationLogoutHandler.mts')]
  ])('%s loads the dotenv file itself', async (file, load) => {
    await load()

    expect(callers.filter((frame) => frame.includes(file))).toHaveLength(1)
  })
})
