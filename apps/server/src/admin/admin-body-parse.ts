// apps/server/src/admin/admin-body-parse.ts
import { BadRequestException } from '@nestjs/common'
/**
 * 后台 DTO 手校小工具（照 pricing-publishing.controller.ts 既有模式）。
 * 后台端点一律手校 Record<string, unknown>，不用 ValidationPipe(whitelist) 对
 * 开放 Record 生效——真实字段丢失机理在「手写白名单漏透传」，白名单必须显式穷举。
 */

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} 必须是非空字符串`)
  }
  return value
}

export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} 必须是有限数，收到: ${String(value)}`)
  }
  return value
}

export function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是字符串或 null`)
  return value
}

export function optionalBool(value: unknown, field: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} 必须是布尔`)
  return value
}

export function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new BadRequestException(`${field} 必须是 ISO 日期字符串或 null`)
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} 不是合法日期: ${value}`)
  return d
}
