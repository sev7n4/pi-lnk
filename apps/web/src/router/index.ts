import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      redirect: '/workflow',
    },
    {
      path: '/workflow',
      name: 'workflow',
      component: () => import('@/pages/WorkflowPage.vue'),
    },
    {
      // 独立注册/登录页（2026-10-23 用户裁决第 6 点）：退出登录后回「身份页」而不是
      // 品牌页；登录成功再回 /workflow 品牌页 ⇒ 登出→重登全程的品牌链路不丢。
      path: '/login',
      name: 'login',
      component: () => import('@/pages/LoginPage.vue'),
    },
    {
      path: '/workflow/:sessionId',
      name: 'canvas',
      component: () => import('@/pages/CanvasPage.vue'),
    },
    {
      // 2026-10-21 P1：画布管理器从主页迁出（主页只留 compact 区5 个 + 查看全部）
      path: '/canvases',
      name: 'canvases',
      component: () => import('@/pages/CanvasesPage.vue'),
    },
    {
      path: '/community',
      name: 'community',
      component: () => import('@/pages/CommunityPage.vue'),
    },
    {
      path: '/replay/:sessionId',
      name: 'replay',
      component: () => import('@/pages/ReplayPage.vue'),
    },
    {
      path: '/creator/:id',
      name: 'creator',
      component: () => import('@/pages/CreatorPage.vue'),
    },
    {
      path: '/share/:id',
      name: 'share',
      component: () => import('@/pages/SharePage.vue'),
    },
    {
      path: '/share/:id/process',
      name: 'share-process',
      component: () => import('@/pages/CanvasReadonlyPage.vue'),
    },
    {
      path: '/stories',
      name: 'stories',
      component: () => import('@/pages/StoriesPage.vue'),
    },
    {
      path: '/text-studio',
      name: 'text-studio',
      component: () => import('@/pages/studios/TextStudioPage.vue'),
    },
    {
      path: '/image-studio',
      name: 'image-studio',
      component: () => import('@/pages/studios/ImageStudioPage.vue'),
    },
    {
      path: '/profile',
      name: 'profile',
      component: () => import('@/pages/ProfilePage.vue'),
    },
    {
      // 我的订阅 / 我的积分：PC 外壳页；内容与移动端共用同一面板组件（只差导航壳）
      path: '/subscription',
      name: 'subscription',
      component: () => import('@/pages/SubscriptionPage.vue'),
    },
    {
      path: '/points',
      name: 'points',
      component: () => import('@/pages/PointsPage.vue'),
    },
    {
      path: '/video-studio',
      name: 'video-studio',
      component: () => import('@/pages/studios/VideoStudioPage.vue'),
    },
    {
      path: '/audio-studio',
      name: 'audio-studio',
      component: () => import('@/pages/studios/AudioStudioPage.vue'),
    },
    {
      path: '/video-editor',
      name: 'video-editor',
      component: () => import('@/pages/studios/VideoEditorPage.vue'),
    },
    {
      path: '/generation-records',
      name: 'generation-records',
      component: () => import('@/pages/studios/GenerationRecordsPage.vue'),
    },
    {
      // 开发预览（仅用于本地肉眼验证 Agent 回合时间线新旧对比，无后端依赖）
      path: '/dev/timeline-preview',
      name: 'dev-timeline-preview',
      component: () => import('@/pages/DevTimelinePreviewPage.vue'),
    },
    {
      path: '/terms',
      name: 'terms',
      component: () => import('../pages/TermsPage.vue'),
    },
    {
      path: '/privacy',
      name: 'privacy',
      component: () => import('../pages/PrivacyPage.vue'),
    },
    {
      path: '/admin',
      component: () => import('@/pages/admin/AdminLayoutPage.vue'),
      children: [
        { path: '', redirect: '/admin/models' },
        { path: 'models', name: 'admin-models', component: () => import('@/pages/admin/AdminModelsPage.vue') },
        { path: 'routes', name: 'admin-routes', component: () => import('@/pages/admin/AdminRoutesPage.vue') },
        { path: 'health', name: 'admin-health', component: () => import('@/pages/admin/AdminHealthPage.vue') },
        { path: 'pricing', name: 'admin-pricing', component: () => import('@/pages/admin/AdminPricingPage.vue') },
        { path: 'pricing-versions', name: 'admin-pricing-versions', component: () => import('@/pages/admin/AdminPricingVersionsPage.vue') },
        { path: 'gray-release', name: 'admin-gray-release', component: () => import('@/pages/admin/AdminGrayReleasePage.vue') },
        { path: 'audit', name: 'admin-audit', component: () => import('@/pages/admin/AdminAuditPage.vue') },
        { path: 'guide', name: 'admin-guide', component: () => import('@/pages/admin/AdminGuidePage.vue') },
      ],
    },
  ],
})

export default router
