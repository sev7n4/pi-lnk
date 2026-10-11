import { defineStore } from 'pinia'
import { ADMIN_TOKEN_KEY, setAdminUnauthorizedHandler } from '@/services/admin-api'

/**
 * Ops Console 会话态（spec §4.2）：token 唯一真源是 sessionStorage，
 * store 只是响应式镜像；401/403 由 admin-api 拦截器清真源并回调 clearToken。
 */
export const useAdminStore = defineStore('admin', {
  state: () => ({ token: sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? '' }),
  getters: {
    hasToken: (state) => state.token.length > 0,
  },
  actions: {
    init() {
      setAdminUnauthorizedHandler(() => this.clearToken())
    },
    setToken(token: string) {
      this.token = token
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token)
    },
    clearToken() {
      this.token = ''
      sessionStorage.removeItem(ADMIN_TOKEN_KEY)
    },
  },
})
