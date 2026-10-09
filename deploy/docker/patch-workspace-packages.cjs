#!/usr/bin/env node
/** Docker build 阶段：将 workspace 包入口指向 dist，便于 Nest CJS 运行时 require */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '../..')
const packages = ['packages/shared/package.json', 'packages/agent/package.json']

for (const rel of packages) {
  const file = path.join(root, rel)
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete pkg.type
  pkg.main = './dist/index.js'
  pkg.types = './dist/index.d.ts'
  pkg.exports = {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
    // B1 S1-1：探活服务 import '@lnkpi/shared/upstreamReconciliation'（复用 shared 的
    // diff 纯函数，禁第二套）。与 src 侧 package.json 的子路径导出一一对应——
    // 这里漏掉会让生产镜像运行时 ERR_PACKAGE_PATH_NOT_EXPORTED。
    './upstreamReconciliation': {
      types: './dist/upstreamReconciliation.d.ts',
      default: './dist/upstreamReconciliation.js',
    },
  }
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`patched ${rel}`)
}
