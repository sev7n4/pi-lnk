export const BRAND_NAME = 'lnk π超创平台'
export const BRAND_LOGO_URL = '/brand/mascot-logo.png'
export const LEGAL_ENTITY = '墨鱼π科技技术有限公司'
export const SUPPORT_EMAIL = 'sev7nseason@outlook.com'
export const ICP_TEXT = 'ICP备案号申请中'
export const TERMS_TITLE = 'lnk π超创平台用户协议'
export const PRIVACY_TITLE = 'lnk π超创平台隐私政策'
export const TERMS_PATH = '/terms'
export const PRIVACY_PATH = '/privacy'

/**
 * 首页签名画面 slogan（2026-10-21 用户裁定，替代原功能副标题
 * 「一句话，在无限画布上生成图像 · 视频 · 漫剧」）。
 *
 * 双行叙事：先共鸣（你体内早就有一囊墨），再品牌承诺（墨鱼π 锚定创意）。
 * 消费方：SignatureHero。⛔ 这两行小字**不得**走品牌渐变（F-5：渐变末端
 * 承载白字实测 3.67:1 低于 AA，渐变只许做 hero 大面 + dim/25 恒黑层）——
 * 一律用 on-signature 实色令牌。
 */
export const BRAND_SLOGAN_LEAD = '你体内早就有一囊墨，只是…没有找到你的锚。'
export const BRAND_SLOGAN_MAIN = '墨鱼π，锚定你的创意，一点一滴洒在画布，让画布记住你的模样。'
/**
 * 主行中的唯一强调词（2026-10-22 用户裁定「slogan 需要一个视觉重音」）。
 *
 * 必须是 BRAND_SLOGAN_MAIN 的**子串**——hero 按它切分渲染（不复制整句，
 * 防两处漂移）；单测锁定「切分拼接后等于 BRAND_SLOGAN_MAIN」。
 * 走 --lnk-accent-on-signature（签名面专用强调色，主题不变式）。
 */
export const BRAND_SLOGAN_MAIN_ACCENT = '锚定'
/**
 * 官网地址（移动端「进入官方」入口）。
 * ⛔ 暂留空：地址尚未确定，先做**预留** —— 留空时点击提示「官网即将上线」，
 * 不用占位域名把人导向 404。定下来后填这里即可，调用方无需改动。
 */
export const OFFICIAL_SITE_URL = ''
