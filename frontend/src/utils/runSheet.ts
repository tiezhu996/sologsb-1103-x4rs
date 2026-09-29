import type { Cue } from '@/types/cue'
import type { Session } from '@/types/session'
import type {
  RehearsalSheet,
  RunAnchorMode,
  RunCueLine,
  RunFlag,
  RunFlagKind,
  RunSection,
  RunSheetSnapshot
} from '@/types/sheet'
import { RUN_ANCHOR_MODE_LABELS } from '@/types/sheet'
import { cueTotalSeconds, formatDateTime, formatSeconds, round1 } from '@/utils/fade'

/** 一天的秒数 */
const DAY_SEC = 86400

/** 计划时刻格式：`HH:mm`（与场次表单校验一致） */
const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** 提示种类的文本标记，用于纯文本拼装 */
const FLAG_MARKS: Record<RunFlagKind, string> = {
  conflict: '【冲突】',
  wait: '【等待】',
  pending: '【待补】'
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 解析 `HH:mm` 为当日秒数；空串或非法格式返回 null */
export function parseClock(text: string): number | null {
  const trimmed = text.trim()
  if (!CLOCK_PATTERN.test(trimmed)) return null
  const [hours, minutes] = trimmed.split(':').map(Number)
  return hours * 3600 + minutes * 60
}

/** 时刻格式化：`19:30` / `19:30:45` / `00:10（次日）`；null 输出「待补」 */
export function formatClock(totalSec: number | null): string {
  if (totalSec === null || !Number.isFinite(totalSec)) return '待补'
  const rounded = Math.max(0, Math.round(totalSec))
  const day = Math.floor(rounded / DAY_SEC)
  const rest = rounded % DAY_SEC
  const hours = Math.floor(rest / 3600)
  const minutes = Math.floor((rest % 3600) / 60)
  const seconds = rest % 60
  const base = seconds === 0 ? `${pad2(hours)}:${pad2(minutes)}` : `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
  if (day === 0) return base
  return day === 1 ? `${base}（次日）` : `${base}（+${day} 天）`
}

/** 联排输入：一个场次及其按时间轴排好序的 Cue */
export interface RunSessionInput {
  session: Session
  cues: Cue[]
}

/** 统计快照中的冲突 / 等待 / 待补数量（全场级 + 各段落） */
export function countRunFlags(snapshot: RunSheetSnapshot): Record<RunFlagKind, number> {
  const counts: Record<RunFlagKind, number> = { conflict: 0, wait: 0, pending: 0 }
  const collect = (flags: readonly RunFlag[]): void => {
    flags.forEach((flag) => {
      counts[flag.kind] += 1
    })
  }
  collect(snapshot.flags)
  snapshot.sections.forEach((section) => collect(section.flags))
  return counts
}

/**
 * 计算整场联排时间线（纯函数）：按场次顺序串联非空场次。
 * - `chain`：从第一个非空场次的计划开场连续走表，场间不留空档；总开场缺计划时刻则全程待补。
 * - `planned`：每场按计划开场时刻接表；越过下一场记冲突、两场间空档记等待、缺计划时刻记待补。
 * 计划时刻按场次顺序递增处理，早于上一场开场的视为次日（跨午夜演出）。
 */
export function computeRunTimeline(inputs: readonly RunSessionInput[], anchorMode: RunAnchorMode): RunSheetSnapshot {
  const nonEmpty = inputs.filter((input) => input.cues.length > 0)
  const skippedSessions = inputs
    .filter((input) => input.cues.length === 0)
    .map((input) => ({
      sessionId: input.session.id,
      sessionOrder: input.session.order,
      sessionTitle: input.session.title
    }))

  const flags: RunFlag[] = []
  let anchorSec: number | null = null
  if (anchorMode === 'chain') {
    const first = nonEmpty[0]
    anchorSec = first ? parseClock(first.session.plannedStart) : null
    if (first && anchorSec === null) {
      flags.push({
        kind: 'pending',
        message: `第 ${first.session.order} 场「${first.session.title}」缺计划开场时刻，总开场待补`
      })
    }
  }

  // planned 模式：先统一推算各场锚点，早于上一场开场的按次日顺延
  const plannedAnchors: Array<number | null> = []
  if (anchorMode === 'planned') {
    let dayOffset = 0
    let previous: number | null = null
    nonEmpty.forEach((input) => {
      const raw = parseClock(input.session.plannedStart)
      if (raw === null) {
        plannedAnchors.push(null)
        return
      }
      let rolled = raw + dayOffset * DAY_SEC
      while (previous !== null && rolled < previous) {
        dayOffset += 1
        rolled = raw + dayOffset * DAY_SEC
      }
      plannedAnchors.push(rolled)
      previous = rolled
    })
  }

  const sections: RunSection[] = []
  let cursor = anchorSec

  nonEmpty.forEach((input, index) => {
    const { session, cues } = input
    const sectionFlags: RunFlag[] = []

    let startSec: number | null
    if (anchorMode === 'chain') {
      startSec = cursor
    } else {
      startSec = plannedAnchors[index]
      if (startSec === null) {
        sectionFlags.push({ kind: 'pending', message: '缺计划开场时刻，本场起止待补' })
      }
    }

    let local = startSec
    const cueLines: RunCueLine[] = cues.map((cue) => {
      const totalSec = cueTotalSeconds(cue)
      const cueStart = local
      const cueEnd = local === null ? null : round1(local + totalSec)
      local = cueEnd
      return {
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        trigger: cue.trigger,
        fadeInSec: cue.fadeInSec,
        holdSec: cue.holdSec,
        fadeOutSec: cue.fadeOutSec,
        totalSec,
        startSec: cueStart,
        endSec: cueEnd,
        note: cue.note
      }
    })
    const endSec = local

    if (anchorMode === 'planned') {
      const next = nonEmpty[index + 1]
      const nextStart = next ? plannedAnchors[index + 1] : null
      if (next && endSec !== null && nextStart !== null) {
        if (endSec > nextStart) {
          sectionFlags.push({
            kind: 'conflict',
            message:
              `越过下一场计划开场 ${formatSeconds(round1(endSec - nextStart))}` +
              `（本场 ${formatClock(endSec)} 才收，第 ${next.session.order} 场计划 ${next.session.plannedStart} 开场）`
          })
        } else if (endSec < nextStart) {
          sectionFlags.push({
            kind: 'wait',
            message:
              `距下一场计划开场空档 ${formatSeconds(round1(nextStart - endSec))}` +
              `（第 ${next.session.order} 场 ${next.session.plannedStart} 开场）`
          })
        }
      }
    }

    sections.push({
      sessionId: session.id,
      sessionOrder: session.order,
      sessionTitle: session.title,
      scriptPage: session.scriptPage,
      plannedStart: session.plannedStart,
      plannedEnd: session.plannedEnd,
      startSec,
      endSec,
      cueLines,
      flags: sectionFlags
    })

    if (anchorMode === 'chain') cursor = endSec
  })

  const startSec = sections.find((section) => section.startSec !== null)?.startSec ?? null
  const endSec = [...sections].reverse().find((section) => section.endSec !== null)?.endSec ?? null
  const totalSec = round1(sections.reduce((sum, section) => sum + section.cueLines.reduce((s, line) => s + line.totalSec, 0), 0))
  const cueCount = sections.reduce((sum, section) => sum + section.cueLines.length, 0)

  return {
    anchorMode,
    anchorSec,
    sections,
    skippedSessions,
    startSec,
    endSec,
    totalSec,
    cueCount,
    sessionCount: sections.length,
    flags
  }
}

/** 一条 Cue 时间线条目的起止文本；两端都缺时刻时只写一次「待补」 */
function formatCueClockRange(line: RunCueLine): string {
  if (line.startSec === null && line.endSec === null) return '待补'
  return `${formatClock(line.startSec)} ~ ${formatClock(line.endSec)}`
}

/** 整场联排表纯文本拼装，用于预览、复制与导出 */
export function buildRunSheetText(sheet: RehearsalSheet): string {
  const run = sheet.run
  if (!run) return ''

  const lines: string[] = []
  lines.push('================ 剧场灯光整场联排表 ================')
  lines.push(`联排表编号：${sheet.sheetNo}`)
  lines.push(`排演方式：${RUN_ANCHOR_MODE_LABELS[run.anchorMode]}`)
  lines.push(`生成时间：${formatDateTime(sheet.generatedAt)}`)
  lines.push(`非空场次：${run.sessionCount}    Cue 数量：${run.cueCount}`)
  lines.push(`全程：${formatClock(run.startSec)} ~ ${formatClock(run.endSec)}（Cue 时长合计 ${formatSeconds(run.totalSec)}）`)
  if (sheet.note) lines.push(`制表备注：${sheet.note}`)
  run.flags.forEach((flag) => lines.push(`${FLAG_MARKS[flag.kind]} ${flag.message}`))
  if (run.skippedSessions.length > 0) {
    const skipped = run.skippedSessions.map((item) => `第 ${item.sessionOrder} 场「${item.sessionTitle}」`).join('、')
    lines.push(`已跳过空场：${skipped}（无 Cue）`)
  }
  lines.push('')

  let cueIndex = 0
  run.sections.forEach((section) => {
    lines.push(
      `【第 ${section.sessionOrder} 场】${section.sessionTitle}` +
        `    剧本 ${section.scriptPage || '—'}    计划 ${section.plannedStart || '—'} ~ ${section.plannedEnd || '—'}`
    )
    const spanText =
      section.startSec !== null && section.endSec !== null
        ? `${formatClock(section.startSec)} ~ ${formatClock(section.endSec)}（历时 ${formatSeconds(round1(section.endSec - section.startSec))}）`
        : '待补'
    lines.push(`  时段：${spanText}`)

    section.cueLines.forEach((line) => {
      cueIndex += 1
      lines.push(
        `  ${pad2(cueIndex)}. [场${section.sessionOrder}] ${line.cueNo}  ${line.label || '（无提示语）'}  [${line.trigger}]`
      )
      lines.push(
        `      时刻：${formatCueClockRange(line)}` +
          `（渐亮 ${formatSeconds(line.fadeInSec)} / 保持 ${formatSeconds(line.holdSec)} / 渐暗 ${formatSeconds(line.fadeOutSec)}，合计 ${formatSeconds(line.totalSec)}）`
      )
      if (line.note) lines.push(`      备注：${line.note}`)
    })

    section.flags.forEach((flag) => lines.push(`  ${FLAG_MARKS[flag.kind]} ${flag.message}`))
    lines.push('')
  })

  const counts = countRunFlags(run)
  lines.push(`提示汇总：冲突 ${counts.conflict} 处 / 等待 ${counts.wait} 处 / 待补 ${counts.pending} 处`)
  lines.push('')
  lines.push('—— 由剧场灯光 Cue 表编排器（gbcuesheet）生成 ——')
  return lines.join('\n')
}
