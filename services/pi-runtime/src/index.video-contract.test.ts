import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendVideoContract, VIDEO_MOTION_CONTRACT_REMINDER } from './tools/video-prompt-contract.js'

// index.ts 合并 after_tool listener 的拼装逻辑抽为纯函数（appendVideoContract），
// 这里测接线语义而不必起 harness：video 成功附纠偏段、失败/其他工具不附、
// 纠偏段拼在截断后 content 末尾（截断不吞纠偏）。

test('接线拼装：video + !isError → 纠偏段在 content 末尾', () => {
	const content = [{ type: 'text' as const, text: '{"ok":true}' }]
	const patched = appendVideoContract(content, 'upsert_media_node', false, { target_type: 'video' })
	assert.equal(patched.length, 2)
	assert.match(patched[patched.length - 1].text, /图生视频 prompt 契约/)
	assert.equal(patched[patched.length - 1].text, VIDEO_MOTION_CONTRACT_REMINDER)
})

test('接线拼装：isError → 不附（没有节点落成，纠偏无对象）', () => {
	const content = [{ type: 'text' as const, text: '{"ok":false}' }]
	const patched = appendVideoContract(content, 'upsert_media_node', true, { target_type: 'video' })
	assert.ok(!patched.some((p) => p.text.includes('图生视频 prompt 契约')))
	assert.equal(patched.length, 1)
})

test('接线拼装：image → 不附', () => {
	const content = [{ type: 'text' as const, text: '{"ok":true}' }]
	const patched = appendVideoContract(content, 'upsert_media_node', false, { target_type: 'image' })
	assert.ok(!patched.some((p) => p.text.includes('图生视频 prompt 契约')))
	assert.equal(patched.length, 1)
})

test('接线拼装：其他工具（如 set_node_text）不附', () => {
	const content = [{ type: 'text' as const, text: '{"ok":true}' }]
	const patched = appendVideoContract(content, 'set_node_text', false, { target_type: 'video' })
	assert.equal(patched.length, 1)
})

test('接线拼装：截断后的 content 仍能附上纠偏段（顺序=先截断后拼接）', () => {
	const truncated = [{ type: 'text' as const, text: '…（已截断：省略 999 字符）' }]
	const patched = appendVideoContract(truncated, 'upsert_media_node', false, { target_type: 'video' })
	assert.equal(patched.length, 2)
	assert.match(patched[0].text, /已截断/)
	assert.match(patched[1].text, /图生视频 prompt 契约/)
})

test('接线拼装：无需纠偏时返回同长度数组（调用方据 length 判定不 patch）', () => {
	const content = [{ type: 'text' as const, text: '{"ok":true}' }]
	const patched = appendVideoContract(content, 'propose_generation', false, { node_id: 'n1' })
	assert.equal(patched.length, content.length)
	assert.deepEqual(patched, content)
})
