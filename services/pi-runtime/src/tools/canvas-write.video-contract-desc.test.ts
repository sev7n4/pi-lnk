import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 描述守卫：图生视频运动契约写进两个工具的 description（spec §5.1 主杠杆 A）。
// 防止后续改 description 时无意删掉契约句。纯源码断言（描述是静态字符串）。

const src = readFileSync(new URL('./canvas-write.ts', import.meta.url), 'utf8')

test('upsert_media_node description 含图生视频运动契约', () => {
	assert.match(src, /reference image\(s\)[\s\S]*?ONLY motion/)
})

test('set_node_generation_params description 含图生视频运动契约', () => {
	const paramsBlock = src.slice(src.indexOf('name: "set_node_generation_params"'))
	assert.ok(paramsBlock.length > 0, 'set_node_generation_params 定义存在')
	assert.match(paramsBlock.slice(0, 2000), /ONLY motion|只描述运动/)
})
