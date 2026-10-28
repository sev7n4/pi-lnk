<script setup lang="ts">
/**
 * 项目卡行内菜单弹层（规格 §13.3/C1）：重命名 / 创建副本 / 删除。
 * 由 ProjectList（移动行卡）与 ProjectGrid（PC 卡墙）共享——菜单是交互契约，
 * 两视图必须同构，禁止各写一份（防语义漂移，同 §6.4 项目名教训）。
 * 开合状态由父级 mgr.openMenuId 承载（单一出处）。
 */
defineEmits<{
  rename: []
  duplicate: []
  remove: []
}>()
</script>

<template>
  <div
    class="absolute right-0 top-8 z-10 w-28 overflow-hidden rounded-xl border border-line bg-surface-base py-1 shadow-lg"
  >
    <button
      type="button"
      class="block w-full px-3 py-1.5 text-left text-xs text-fg transition hover:bg-hover"
      @click="$emit('rename')"
    >
      重命名
    </button>
    <button
      type="button"
      class="block w-full px-3 py-1.5 text-left text-xs text-fg transition hover:bg-hover"
      @click="$emit('duplicate')"
    >
      创建副本
    </button>
    <button
      type="button"
      class="block w-full px-3 py-1.5 text-left text-xs text-danger transition hover:bg-hover"
      @click="$emit('remove')"
    >
      删除
    </button>
  </div>
</template>
