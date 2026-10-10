/**
 * Tailwind 配置 —— 颜色一律指向 `styles/design-tokens.css` 的 L2 语义变量。
 *
 * ⛔ **不要在这里写死 hex**：这里曾经硬编码过一整套深色专用色（brand.* / electric / warm /
 *    surface.*），结果是「第三个颜色真相源」——改令牌文件不会反映到 Tailwind 类上，
 *    而浅色主题根本无从覆写。已实测：`brand.300`~`brand.700`、`electric`、`warm`
 *    在 182 个 SFC 里**使用量全部为 0**，纯属僵尸配置（本轮已删除）。
 *
 * ⛔ **副作用：CSS 变量类不支持透明度修饰符**。`text-fg/50` 不会生成任何 CSS
 *    （Tailwind 无法对 `var(...)` 做 alpha 合成）。需要淡化文字请用 `text-fg-2` / `text-fg-3`
 *    这类**已经实测过对比度**的档位，不要另造透明度。
 *
 * ## 本轮只令牌化了「颜色 + 字体族 + 渐变」
 *
 * 字号 / 圆角 / 阴影**故意没接**：Tailwind 默认阶梯与 design-tokens 的命名不是一一对应
 * （如 `text-sm` 默认 14px vs 令牌 13px、`rounded-xl` 默认 12px vs 令牌 16px），
 * 一旦覆盖就会**静默改写全站既有类名的实际取值**——那是视觉改版，不是主题修复，
 * 必须配合视觉回归单独做（P1）。这里只新增**不与默认键冲突**的语义别名
 * （`duration-fast` / `ease-standard` / `z-chrome` / `shadow-glow`），不改变任何默认值。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        /* ---- 文字：三档，对应 --lnk-text-primary / secondary / muted ---- */
        fg: {
          DEFAULT: 'var(--lnk-text-primary)',
          2: 'var(--lnk-text-secondary)',
          3: 'var(--lnk-text-muted)',
          disabled: 'var(--lnk-text-disabled)',
          on: 'var(--lnk-text-on-accent)', // 压在 accent 底色上的文字
          accent: 'var(--lnk-accent-text)', // 表面上的紫字 / 链接
        },

        /* ---- 表面：由远及近 ---- */
        surface: {
          DEFAULT: 'var(--lnk-surface-canvas)', // 旧值即画布底色，保持不变以免回归
          canvas: 'var(--lnk-surface-canvas)',
          sunken: 'var(--lnk-surface-sunken)',
          base: 'var(--lnk-surface-base)',
          card: 'var(--lnk-surface-base)', // 旧 card 语义 == base
          elevated: 'var(--lnk-surface-raised)',
          overlay: 'var(--lnk-surface-overlay)',
          border: 'var(--lnk-border-subtle)',
        },

        /* ---- 描边 ---- */
        line: {
          subtle: 'var(--lnk-border-subtle)',
          DEFAULT: 'var(--lnk-border-default)',
          strong: 'var(--lnk-border-strong)',
          focus: 'var(--lnk-border-focus)',
        },

        /* ---- 品牌点睛 ---- */
        accent: {
          DEFAULT: 'var(--lnk-accent)',
          hover: 'var(--lnk-accent-hover)',
          active: 'var(--lnk-accent-active)',
          subtle: 'var(--lnk-accent-subtle)',
        },

        /* ---- 单语义强调色（各锁一个含义，不得混用）---- */
        energy: 'var(--lnk-energy)', // 仅：连线 / 能量流动
        credit: 'var(--lnk-credit)', // 仅：积分 / 消耗

        /* ---- 状态 ---- */
        success: 'var(--lnk-success)',
        warning: 'var(--lnk-warning)',
        danger: 'var(--lnk-error)',
        info: 'var(--lnk-info)',
      },
      fontFamily: {
        // 中文字体必须显式声明：Unbounded / Inter 没有 CJK 字形，
        // 旧配置只写 system-ui，在部分平台上会静默回退到非预期字体。
        display: ['var(--lnk-font-display)'],
        sans: ['var(--lnk-font-sans)'],
        mono: ['var(--lnk-font-mono)'],
      },
      // ⚠️ 以下全是**新增键**，不与 Tailwind 默认键冲突，故不改变既有类名取值
      boxShadow: {
        glow: 'var(--lnk-accent-glow)',
      },
      zIndex: {
        'canvas-ui': 'var(--lnk-z-canvas-ui)',
        chrome: 'var(--lnk-z-chrome)',
        dock: 'var(--lnk-z-dock)',
        overlay: 'var(--lnk-z-overlay)',
        modal: 'var(--lnk-z-modal)',
        toast: 'var(--lnk-z-toast)',
      },
      transitionDuration: {
        instant: 'var(--lnk-duration-instant)',
        fast: 'var(--lnk-duration-fast)',
        slow: 'var(--lnk-duration-slow)',
        slower: 'var(--lnk-duration-slower)',
      },
      transitionTimingFunction: {
        standard: 'var(--lnk-ease-standard)',
        decelerate: 'var(--lnk-ease-decelerate)',
        accelerate: 'var(--lnk-ease-accelerate)',
        spring: 'var(--lnk-ease-spring)',
      },
      backgroundImage: {
        'hero-gradient':
          'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(109,93,252,0.25), transparent)',
        'brand-gradient': 'var(--lnk-accent-gradient)',
        glass: 'var(--lnk-surface-glass)',
      },
    },
  },
  plugins: [],
}
