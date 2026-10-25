export const BRAND_NAME = 'lnk π超创平台'
/**
 * 品牌字标短名（2026-10-23 用户裁定）：导航左上角等**品牌展示位**只露「lnk π」，
 * 完整名 BRAND_NAME 保留给法务文书（用户协议 / 隐私政策标题与正文）。
 */
export const BRAND_SHORT_NAME = 'lnk π'
export const BRAND_LOGO_URL = '/brand/mascot-logo.png'
/**
 * 品牌**标志**位（导航头 / 法务页头 / favicon）用双色徽标（2026-10-26 用户裁定）。
 *
 * ⛔ 为什么不能直接改 `BRAND_LOGO_URL` 指向徽标：那一个常量同时供 5 个位
 *    （导航头 BrandLogo / 隐私·协议页头 / favicon / slogan 下**吉祥物** / AI 助手头像）。
 *    用户 2026-10-26 裁定①「slogan 下的品牌形象吉祥物**不做替换**」⇒ 吉祥物继续走
 *    `BRAND_LOGO_URL`，标志位另立这两个常量，二者互不牵连。
 *
 * ⛔ 为什么必须是**两版**：徽标是「盘 + 锚」的双色资产，盘色不随主题变。
 *    黑盘落在深色导航头上会整枚沉进背景、只剩白锚（读不出徽标）；
 *    白盘落在浅色法务页上同理。⇒ 按主题反相取用：
 *      · 浅色主题（浅底）→ 黑盘白锚（anchor-badge.png）
 *      · 深色主题（深底）→ 白盘黑锚（anchor-badge-invert.png，严格 RGB 反相）
 *    取用逻辑收在 `useBrandMark()`，三个消费位共用，防各自写歪。
 */
export const BRAND_MARK_ON_LIGHT_URL = '/brand/anchor-badge.png'
export const BRAND_MARK_ON_DARK_URL = '/brand/anchor-badge-invert.png'
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
/**
 * 2026-10-23 用户裁决：「让画布记住你的模样」→「让世界记住你的模样」——
 * 品牌承诺从工具（画布）升到世界（作品走出画布才被世界记住）。
 * ⛔ 移动端与 PC 端共用这一句（单一真相源）⇒ 改这里两端同时生效。
 * ⚠️ BRAND_SLOGAN_MAIN_MASCOT_BEFORE（inline 墨鱼位）必须仍是本句子串：
 * 「让世界记住你的模样」含「记住你的模样」⇒ 墨鱼位不受影响（单测锁父句相等）。
 */
export const BRAND_SLOGAN_MAIN = '墨鱼π，锚定你的创意，一点一滴洒在画布，让世界记住你的模样。'
/**
 * 主行中的唯一强调词（2026-10-22 用户裁定「slogan 需要一个视觉重音」）。
 *
 * 必须是 BRAND_SLOGAN_MAIN 的**子串**——hero 按它切分渲染（不复制整句，
 * 防两处漂移）；单测锁定「切分拼接后等于 BRAND_SLOGAN_MAIN」。
 * 走 --lnk-accent-on-signature（签名面专用强调色，主题不变式）。
 */
export const BRAND_SLOGAN_MAIN_ACCENT = '锚定'
/**
 * inline 墨鱼位：主行中该词**之前**（2026-10-22 用户裁定「墨鱼放在『记住你的
 * 模样』前面，位置上给人感觉墨正好从它身上撒下来」）。渲染时与该词粘为
 * nowrap 一体，不被拆行；必须是 BRAND_SLOGAN_MAIN 的子串——若漂移，
 * inline 墨鱼会静默消失（单测锁父元素为 h1 兜底）。
 */
export const BRAND_SLOGAN_MAIN_MASCOT_BEFORE = '记住你的模样'
/**
 * 官网地址（移动端「进入官方」入口）。
 * ⛔ 暂留空：地址尚未确定，先做**预留** —— 留空时点击提示「官网即将上线」，
 * 不用占位域名把人导向 404。定下来后填这里即可，调用方无需改动。
 */
export const OFFICIAL_SITE_URL = ''
