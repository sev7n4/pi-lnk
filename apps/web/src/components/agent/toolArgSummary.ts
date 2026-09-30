/**
 * 工具入参摘要（可观测性专项 ②）：执行过程里展示「调用了什么」之外的关键「对什么操作」。
 * 只挑人可读的关键字段；未覆盖的工具返回 undefined（列表只显示工具名）。
 */
const ARGS_SUMMARY_MAX = 24

export function summarizeToolArgs(name: string, args: unknown): string | undefined {
  if (args == null || typeof args !== 'object') return undefined
  const a = args as Record<string, unknown>
  switch (name) {
    case 'load_skill':
      return typeof a.name === 'string' && a.name ? a.name : undefined
    case 'upsert_media_node': {
      if (typeof a.title === 'string' && a.title) return a.title.slice(0, ARGS_SUMMARY_MAX)
      if (typeof a.prompt === 'string' && a.prompt) return a.prompt.slice(0, ARGS_SUMMARY_MAX)
      return undefined
    }
    case 'propose_generation': {
      if (Array.isArray(a.node_ids) && a.node_ids.length > 0) return `${a.node_ids.length} 个节点`
      if (typeof a.node_id === 'string' && a.node_id) return '1 个节点'
      return undefined
    }
    case 'cancel_generation':
      return typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'upsert_prompt_node':
    case 'get_node':
    case 'duplicate_node':
      return typeof a.title === 'string' && a.title ? a.title.slice(0, ARGS_SUMMARY_MAX)
        : typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'set_node_text':
      return typeof a.text === 'string' && a.text ? a.text.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'connect_nodes':
      return Array.isArray(a.edges) && a.edges.length > 0 ? `${a.edges.length} 条连线` : undefined
    case 'attach_refs':
    case 'apply_sidebar_attachments': {
      const list = a.attachments ?? a.ref_keys
      return Array.isArray(list) ? `${list.length} 个素材` : undefined
    }
    case 'grid_slice_image':
      return typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'ask_user':
      return typeof a.question === 'string' && a.question ? a.question.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'focus_node':
      return typeof a.node_id === 'string' && a.node_id ? a.node_id.slice(0, ARGS_SUMMARY_MAX) : undefined
    case 'focus_nodes':
    case 'arrange_nodes':
      return Array.isArray(a.node_ids) && a.node_ids.length > 0 ? `${a.node_ids.length} 个节点` : undefined
    default:
      return undefined
  }
}
