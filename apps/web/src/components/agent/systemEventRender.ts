const SYSTEM_EVENT_PREFIX = '[系统事件·'

/**
 * 宿主回注消息判据（spec §6.4，PR3 Task5）：文本前缀即真相。
 * 与 followUp / system-turn 两路同源（lane 纯文本、无元数据通道），
 * 不为一条通知发明元数据通道（spec §8 非目标）。
 */
export function isSystemEventText(text: unknown): boolean {
  return typeof text === 'string' && text.startsWith(SYSTEM_EVENT_PREFIX)
}
