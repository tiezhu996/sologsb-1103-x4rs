import type { Cue } from '@/types/cue'
import type { RunAnchorMode } from '@/types/sheet'
import type { Session } from '@/types/session'
import { sortCues } from '@/utils/cueOrder'
import { cueTotalSeconds, formatSeconds } from '@/utils/fade'

/** 时刻锚定方式（与 sheet 类型保持一致） */
export type { RunAnchorMode }

/** 一条 Cue 的联排时刻（当日 0 点起秒数） */
export interface RunCueTime {
  cue: Cue
  /** 开场时刻（秒）；无法锚定时为 null */
  startSec: number | null
  /** 结束时刻（秒）；无法锚定时为 null */
  endSec: number | null
}

/** 联排中的一个场次块 */
export interface RunSessionBlock {
  session: Session
  cues: RunCueTime[]
  /** 该块无法锚定（计划时刻 / 总开场缺失），时刻标待补 */
  pending: boolean
  /** 该块首条 Cue 开场秒数（用于衔接比对） */
  firstStartSec: number | null
  /** 该块末条 Cue 结束秒数 */
  lastEndSec: number | null
}

/** 两场之间的衔接类型 */
export type RunMarkerType = 'wait' | 'conflict' | 'pending'

/** 场次衔接提示 */
export interface RunMarker {
  fromSessionId: string
  toSessionId: string
  type: RunMarkerType
  /** 差额秒数：wait 为等待时长，conflict 为越界时长；pending 时为 null */
  deltaSec: number | null
  /** 说明文本 */
  text: string
}

/** 整场联排时间线计算结果 */
export interface RunTimeline {
  blocks: RunSessionBlock[]
  markers: RunMarker[]
  /** 所有 Cue 时长合计（秒） */
  totalSec: number
  /** 无法锚定的场次块数 */
  pendingCount: number
}

/** `HH:mm` → 当日 0 点起秒数；格式非法返回 null */
export function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim())
  if (!match) return null
  const [hours, minutes] = value.trim().split(':').map((part) => Number.parseInt(part, 10))
  return hours * 3600 + minutes * 60
}

/** 当日 0 点起秒数 → `HH:mm`（不跨天取模，超出 24 小时顺延小时数） */
export function formatClock(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return '待补'
  const total = Math.max(0, Math.round(sec))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** 等待 / 冲突差额的文案，如 `等待 8m` / `冲突 1m20s` */
function formatDelta(type: RunMarkerType, deltaSec: number): string {
  const abs = Math.abs(Math.round(deltaSec))
  if (type === 'wait') return `等待 ${formatSeconds(abs)}`
  return `冲突 ${formatSeconds(abs)}`
}

/** 计算整场联排时间线：场次按演出顺序，Cue 按时间轴顺序 */
export function buildRunTimeline(
  sessions: Session[],
  cuesBySession: Map<string, Cue[]>,
  anchorMode: RunAnchorMode,
  runStart: string
): RunTimeline {
  const ordered = [...sessions].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  const blocks: RunSessionBlock[] = []
  const markers: RunMarker[] = []
  let totalSec = 0
  let pendingCount = 0

  // 总开场连排：全程共用一个游标；接表模式：每场从自己的计划时刻重新起算
  let cursor: number | null = anchorMode === 'continuous' ? parseClock(runStart) : null

  ordered.forEach((session) => {
    const cues = sortCues(cuesBySession.get(session.id) ?? [])
    const block: RunSessionBlock = {
      session,
      cues: [],
      pending: false,
      firstStartSec: null,
      lastEndSec: null
    }

    let blockPending = false
    if (anchorMode === 'planned') {
      const planned = parseClock(session.plannedStart)
      if (planned === null) blockPending = true
      else cursor = planned
    } else if (cursor === null) {
      blockPending = true
    }

    let blockFirst: number | null = null
    let blockLast: number | null = null
    cues.forEach((cue) => {
      const duration = cueTotalSeconds(cue)
      totalSec += duration
      let startSec: number | null = null
      let endSec: number | null = null
      if (!blockPending && cursor !== null) {
        startSec = cursor
        endSec = cursor + duration
        cursor = endSec
        if (blockFirst === null) blockFirst = startSec
        blockLast = endSec
      }
      block.cues.push({ cue, startSec, endSec })
    })

    block.pending = blockPending
    block.firstStartSec = blockFirst
    block.lastEndSec = blockLast
    if (blockPending) pendingCount += 1
    blocks.push(block)
  })

  for (let index = 1; index < blocks.length; index += 1) {
    const marker = buildMarker(blocks[index - 1], blocks[index], anchorMode, index === 1)
    if (marker) markers.push(marker)
  }

  return { blocks, markers, totalSec, pendingCount }
}

/** 生成相邻两场的衔接提示；无异常衔接（准点接上）时返回 null */
function buildMarker(
  prev: RunSessionBlock,
  next: RunSessionBlock,
  anchorMode: RunAnchorMode,
  isFirstBoundary: boolean
): RunMarker | null {
  const fromSessionId = prev.session.id
  const toSessionId = next.session.id

  if (anchorMode === 'planned') {
    const prevPlanned = parseClock(prev.session.plannedStart)
    const nextPlanned = parseClock(next.session.plannedStart)
    if (prevPlanned === null || nextPlanned === null) {
      const missing: string[] = []
      if (prevPlanned === null) missing.push(`第 ${prev.session.order} 场计划时刻`)
      if (nextPlanned === null) missing.push(`第 ${next.session.order} 场计划时刻`)
      return {
        fromSessionId,
        toSessionId,
        type: 'pending',
        deltaSec: null,
        text: `待补：${missing.join('、')}未填，两场衔接时刻无法确定`
      }
    }
    if (prev.lastEndSec === null || next.firstStartSec === null) {
      return {
        fromSessionId,
        toSessionId,
        type: 'pending',
        deltaSec: null,
        text: `待补：第 ${prev.session.order} 场或第 ${next.session.order} 场时刻缺失，无法衔接`
      }
    }
    const gap = nextPlanned - prev.lastEndSec
    if (gap > 0) {
      return {
        fromSessionId,
        toSessionId,
        type: 'wait',
        deltaSec: gap,
        text: `${formatDelta('wait', gap)}：第 ${prev.session.order} 场结束（${formatClock(prev.lastEndSec)}）距第 ${
          next.session.order
        } 场计划开场（${formatClock(nextPlanned)}）还有空档`
      }
    }
    if (gap < 0) {
      return {
        fromSessionId,
        toSessionId,
        type: 'conflict',
        deltaSec: gap,
        text: `${formatDelta('conflict', gap)}：第 ${prev.session.order} 场结束已越过第 ${
          next.session.order
        } 场计划开场（${formatClock(nextPlanned)}）`
      }
    }
    return null
  }

  // 总开场连排：场与场之间首尾相接无空档，仅比对连排到达时刻与下一场计划开场
  if (next.firstStartSec === null) {
    if (!isFirstBoundary) return null
    return {
      fromSessionId,
      toSessionId,
      type: 'pending',
      deltaSec: null,
      text: '待补：总开场时刻未填，各场时刻无法推算'
    }
  }
  const nextPlanned = parseClock(next.session.plannedStart)
  if (nextPlanned === null) {
    return {
      fromSessionId,
      toSessionId,
      type: 'pending',
      deltaSec: null,
      text: `待补：第 ${next.session.order} 场计划时刻未填，连排到达 ${formatClock(next.firstStartSec)} 无法比对`
    }
  }
  const delta = next.firstStartSec - nextPlanned
  if (delta > 0) {
    return {
      fromSessionId,
      toSessionId,
      type: 'conflict',
      deltaSec: delta,
      text: `${formatDelta('conflict', delta)}：连排到达第 ${next.session.order} 场的时间晚于计划开场（${formatClock(
        nextPlanned
      )}）`
    }
  }
  return null
}
