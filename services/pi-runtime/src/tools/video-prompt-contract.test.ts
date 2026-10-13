import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoContractReminder, VIDEO_MOTION_CONTRACT_REMINDER } from './video-prompt-contract.js'

test('target_type=video → 返回纠偏文本', () => {
	const out = videoContractReminder({ target_type: 'video', prompt: '一只狼' })
	assert.ok(out && out.length > 0)
	assert.equal(out, VIDEO_MOTION_CONTRACT_REMINDER)
})

test('target_type=image → null（不误触发）', () => {
	assert.equal(videoContractReminder({ target_type: 'image' }), null)
})

test('target_type 缺失/非字符串 → null（形态不符不猜）', () => {
	assert.equal(videoContractReminder({}), null)
	assert.equal(videoContractReminder({ target_type: 42 }), null)
	assert.equal(videoContractReminder(null), null)
})

test('纠偏文本 ≤300 字且含六段式索引与铁律', () => {
	assert.ok(VIDEO_MOTION_CONTRACT_REMINDER.length <= 300)
	assert.match(VIDEO_MOTION_CONTRACT_REMINDER, /运镜/)
	assert.match(VIDEO_MOTION_CONTRACT_REMINDER, /只描述运动|只写运动/)
})
