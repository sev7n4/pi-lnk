import { defineConfig } from 'vitest/config'
import swc from 'unplugin-swc'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    // 本地是 4 核 Mac 且多 agent 并存（曾实测 load 21+）：默认 worker 数会把机器打满。
    // CI 是独占 4 vCPU runner，保持满速；本地一律压到 2 个 fork，给并行会话留余量。
    poolOptions: { forks: { maxForks: process.env.CI ? 4 : 2 } },
  },
  plugins: [
    swc.vite({
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }),
  ],
})
