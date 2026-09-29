import type { Cue, CueOrderSummary, AdjacentTransition } from '@/types/cue'
import type { FixturePosition } from '@/types/fixture'
import type { ColorTempCheck, ColorTempItem } from '@/types/level'
import { COLOR_TEMP_TOLERANCE_K } from '@/types/level'
import type { RehearsalSheet, SheetCueLine, SheetRunSession } from '@/types/sheet'
import type { Session } from '@/types/session'
import { sortCues } from '@/utils/cueOrder'

/** 过渡比例：渐亮 / 保持 / 渐暗 各占的比例（0-1） */
export interface FadeRatio {
  fadeIn: number
  hold: number
  fadeOut: number
}

/** 保留一位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 秒数格式化：`3s` / `3.5s` / `1m20s` */
export function formatSeconds(sec: number): string {
  const safe = Number.isFinite(sec) ? Math.max(0, sec) : 0
  const rounded = round1(safe)
  if (rounded >= 60) {
    const minutes = Math.floor(rounded / 60)
    const rest = round1(rounded - minutes * 60)
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`
  }
  return `${rounded}s`
}

/** 时间戳 / ISO 字符串 → `YYYY-MM-DD HH:mm:ss` */
export function formatDateTime(value: string | number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (input: number): string => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`
}

/** 单条 Cue 的总时长（渐亮 + 保持 + 渐暗） */
export function cueTotalSeconds(cue: Pick<Cue, 'fadeInSec' | 'fadeOutSec' | 'holdSec'>): number {
  return round1(cue.fadeInSec + cue.holdSec + cue.fadeOutSec)
}

/** 单条 Cue 的过渡描述文本 */
export function formatTransition(cue: Pick<Cue, 'fadeInSec' | 'fadeOutSec' | 'holdSec'>): string {
  return `渐亮 ${formatSeconds(cue.fadeInSec)} → 保持 ${formatSeconds(cue.holdSec)} → 渐暗 ${formatSeconds(cue.fadeOutSec)}`
}

/** 渐变条比例：总时长为 0 时三段均为 0 */
export function fadeRatio(input: Pick<Cue, 'fadeInSec' | 'holdSec' | 'fadeOutSec'>): FadeRatio {
  const total = cueTotalSeconds(input)
  if (total <= 0) return { fadeIn: 0, hold: 0, fadeOut: 0 }
  return {
    fadeIn: input.fadeInSec / total,
    hold: input.holdSec / total,
    fadeOut: input.fadeOutSec / total
  }
}

/** 汇总一组 Cue 的过渡时长，并给出相邻衔接关系 */
export function sumCues(input: readonly Cue[]): CueOrderSummary {
  const cues = sortCues(input)
  let totalFadeInSec = 0
  let totalFadeOutSec = 0
  let totalHoldSec = 0
  const adjacent: AdjacentTransition[] = []

  cues.forEach((cue, index) => {
    totalFadeInSec += cue.fadeInSec
    totalFadeOutSec += cue.fadeOutSec
    totalHoldSec += cue.holdSec
    if (index === 0) return
    const previous = cues[index - 1]
    const gapSec = round1(previous.fadeOutSec + cue.fadeInSec)
    adjacent.push({
      fromCueId: previous.id,
      fromCueNo: previous.cueNo,
      toCueId: cue.id,
      toCueNo: cue.cueNo,
      gapSec,
      overlap: gapSec < 1
    })
  })

  return {
    totalFadeInSec: round1(totalFadeInSec),
    totalFadeOutSec: round1(totalFadeOutSec),
    totalHoldSec: round1(totalHoldSec),
    totalSec: round1(totalFadeInSec + totalFadeOutSec + totalHoldSec),
    adjacent
  }
}

/** 色温一致性判定：以出现次数最多的色温为基准，超过容差即漂移 */
export function checkColorTempConsistency(
  input: ReadonlyArray<{ fixtureId: string; channel: number; position: FixturePosition; colorTempK: number }>
): ColorTempCheck {
  if (input.length === 0) {
    return {
      dominantK: 0,
      toleranceK: COLOR_TEMP_TOLERANCE_K,
      items: [],
      consistent: true,
      message: '尚未为该 Cue 设定任何通道电平'
    }
  }

  const histogram = new Map<number, number>()
  input.forEach((item) => histogram.set(item.colorTempK, (histogram.get(item.colorTempK) ?? 0) + 1))

  let dominantK = input[0].colorTempK
  let dominantCount = -1
  Array.from(histogram.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .forEach(([kelvin, count]) => {
      if (count > dominantCount) {
        dominantK = kelvin
        dominantCount = count
      }
    })

  const items: ColorTempItem[] = input.map((item) => {
    const driftK = Math.abs(item.colorTempK - dominantK)
    return { ...item, driftK, consistent: driftK <= COLOR_TEMP_TOLERANCE_K }
  })
  const drifted = items.filter((item) => !item.consistent)

  return {
    dominantK,
    toleranceK: COLOR_TEMP_TOLERANCE_K,
    items,
    consistent: drifted.length === 0,
    message:
      drifted.length === 0
        ? `色温一致：基准 ${dominantK}K，容差 ±${COLOR_TEMP_TOLERANCE_K}K`
        : `色温漂移：${drifted.map((item) => `CH${item.channel}(${item.colorTempK}K)`).join('、')} 偏离基准 ${dominantK}K`
  }
}

/** 把一条 Cue 快照渲染为多行文本 */
function formatCueLineText(line: SheetCueLine, index: number): string[] {
  const total = round1(line.fadeInSec + line.holdSec + line.fadeOutSec)
  const rows: string[] = []
  rows.push(`${String(index + 1).padStart(2, '0')}. ${line.cueNo}  ${line.label || '（无提示语）'}  [${line.trigger}]`)
  rows.push(`    过渡：渐亮 ${formatSeconds(line.fadeInSec)} / 保持 ${formatSeconds(line.holdSec)} / 渐暗 ${formatSeconds(
    line.fadeOutSec
  )}（合计 ${formatSeconds(total)}）`)
  if (line.note) rows.push(`    备注：${line.note}`)
  if (line.channels.length === 0) {
    rows.push('    通道电平：未设定')
  } else {
    line.channels.forEach((channel) => {
      rows.push(
        `    CH${String(channel.channel).padStart(3, ' ')} ${channel.position}/${channel.fixtureType}` +
          ` 亮度 ${channel.intensity}%  色温 ${channel.colorTempK}K  色纸 ${channel.gel || '—'}` +
          (channel.focusNote ? `  对焦：${channel.focusNote}` : '')
      )
    })
  }
  return rows
}

/** 排演表纯文本拼装，用于预览、复制与导出 */
export function buildSheetText(sheet: RehearsalSheet, session?: Session): string {
  if (sheet.kind === 'run') return buildRunSheetText(sheet)
  return buildSingleSheetText(sheet, session)
}

/** 联排表时刻：当日 0 点起秒数 → `HH:mm`，缺失显示「待补」 */
function formatRunClock(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '待补'
  const total = Math.max(0, Math.round(sec))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** 联排表中的一条 Cue（含场次与起止时刻） */
function formatRunCueLineText(line: SheetCueLine, index: number): string[] {
  const total = round1(line.fadeInSec + line.holdSec + line.fadeOutSec)
  const rows: string[] = []
  rows.push(`${String(index + 1).padStart(2, '0')}. ${line.cueNo}  ${line.label || '（无提示语）'}  [${line.trigger}]`)
  rows.push(
    `    时刻：${formatRunClock(line.clockStartSec)} ~ ${formatRunClock(line.clockEndSec)}` +
      `（时长 ${formatSeconds(total)}：渐亮 ${formatSeconds(line.fadeInSec)} / 保持 ${formatSeconds(line.holdSec)} / 渐暗 ${formatSeconds(
        line.fadeOutSec
      )}）`
  )
  if (line.note) rows.push(`    备注：${line.note}`)
  if (line.channels.length === 0) {
    rows.push('    通道电平：未设定')
  } else {
    line.channels.forEach((channel) => {
      rows.push(
        `    CH${String(channel.channel).padStart(3, ' ')} ${channel.position}/${channel.fixtureType}` +
          ` 亮度 ${channel.intensity}%  色温 ${channel.colorTempK}K  色纸 ${channel.gel || '—'}` +
          (channel.focusNote ? `  对焦：${channel.focusNote}` : '')
      )
    })
  }
  return rows
}

/** 联排表中的一个场次块 */
function formatRunSessionBlock(block: SheetRunSession, startIndex: number): { rows: string[]; nextIndex: number } {
  const rows: string[] = []
  rows.push(`—— 第 ${block.order} 场 · ${block.title} ——`)
  rows.push(
    `剧本页码：${block.scriptPage || '—'}    计划时刻：${block.plannedStart || '待补'} ~ ${block.plannedEnd || '待补'}`
  )
  if (block.stageNote) rows.push(`舞台状态：${block.stageNote}`)
  if (block.pending) rows.push('（本场计划时刻缺失，以下 Cue 时刻均为待补）')
  if (block.cueLines.length === 0) {
    rows.push('（本场未包含 Cue）')
  } else {
    block.cueLines.forEach((line, index) => {
      rows.push(...formatRunCueLineText(line, startIndex + index))
    })
  }
  return { rows, nextIndex: startIndex + block.cueLines.length }
}

/** 整场联排表纯文本拼装 */
function buildRunSheetText(sheet: RehearsalSheet): string {
  const lines: string[] = []
  lines.push('================ 剧场灯光排演表 ================')
  lines.push(`排演表编号：${sheet.sheetNo}`)
  lines.push(`类型：整场联排表（${sheet.runAnchorMode === 'planned' ? '按各场计划时刻接表' : '总开场连排'}）`)
  if (sheet.runAnchorMode === 'continuous') {
    lines.push(`总开场时刻：${sheet.runStart || '待补'}`)
  }
  lines.push(`生成时间：${formatDateTime(sheet.generatedAt)}`)
  lines.push(`包含场次：${sheet.runSessions?.length ?? 0} 场（非空场次按演出顺序串接）`)
  lines.push(`Cue 数量：${sheet.cueLines.length}`)
  if (sheet.note) lines.push(`制表备注：${sheet.note}`)
  lines.push('')

  const blocks = sheet.runSessions ?? []
  if (blocks.length === 0) {
    lines.push('（联排表未包含任何场次）')
  } else {
    let cueIndex = 0
    blocks.forEach((block, blockIndex) => {
      const { rows, nextIndex } = formatRunSessionBlock(block, cueIndex)
      lines.push(...rows)
      cueIndex = nextIndex
      const marker = sheet.runMarkers?.find((item) => item.fromSessionId === block.sessionId)
      if (marker) {
        lines.push('')
        lines.push(`  ▼ ${marker.text}`)
        lines.push('')
      } else if (blockIndex < blocks.length - 1) {
        lines.push('')
      }
    })

    const cueLike = sheet.cueLines.map((line) => ({
      fadeInSec: line.fadeInSec,
      holdSec: line.holdSec,
      fadeOutSec: line.fadeOutSec
    }))
    const totalFadeIn = round1(cueLike.reduce((sum, cue) => sum + cue.fadeInSec, 0))
    const totalHold = round1(cueLike.reduce((sum, cue) => sum + cue.holdSec, 0))
    const totalFadeOut = round1(cueLike.reduce((sum, cue) => sum + cue.fadeOutSec, 0))
    lines.push(
      `合计过渡：渐亮 ${formatSeconds(totalFadeIn)} / 保持 ${formatSeconds(totalHold)} / 渐暗 ${formatSeconds(
        totalFadeOut
      )}（总计 ${formatSeconds(round1(totalFadeIn + totalHold + totalFadeOut))}）`
    )
  }

  lines.push('')
  lines.push('—— 由剧场灯光 Cue 表编排器（gbcuesheet）生成 ——')
  return lines.join('\n')
}

/** 单场排演表纯文本拼装 */
function buildSingleSheetText(sheet: RehearsalSheet, session?: Session): string {
  const lines: string[] = []
  lines.push('================ 剧场灯光排演表 ================')
  lines.push(`排演表编号：${sheet.sheetNo}`)
  lines.push(`场次：${session ? `${session.order}. ${session.title}` : '（场次已删除）'}`)
  if (session) {
    lines.push(`剧本页码：${session.scriptPage || '—'}    计划时刻：${session.plannedStart || '—'} ~ ${session.plannedEnd || '—'}`)
    if (session.stageNote) lines.push(`舞台状态：${session.stageNote}`)
  }
  lines.push(`生成时间：${formatDateTime(sheet.generatedAt)}`)
  lines.push(`Cue 数量：${sheet.cueLines.length}`)
  if (sheet.note) lines.push(`制表备注：${sheet.note}`)
  lines.push('')

  if (sheet.cueLines.length === 0) {
    lines.push('（本表未包含任何 Cue）')
  } else {
    const cueLike = sheet.cueLines.map((line) => ({ fadeInSec: line.fadeInSec, holdSec: line.holdSec, fadeOutSec: line.fadeOutSec }))
    const totalFadeIn = round1(cueLike.reduce((sum, cue) => sum + cue.fadeInSec, 0))
    const totalHold = round1(cueLike.reduce((sum, cue) => sum + cue.holdSec, 0))
    const totalFadeOut = round1(cueLike.reduce((sum, cue) => sum + cue.fadeOutSec, 0))
    sheet.cueLines.forEach((line, index) => {
      lines.push(...formatCueLineText(line, index))
    })
    lines.push('')
    lines.push(
      `合计过渡：渐亮 ${formatSeconds(totalFadeIn)} / 保持 ${formatSeconds(totalHold)} / 渐暗 ${formatSeconds(
        totalFadeOut
      )}（总计 ${formatSeconds(round1(totalFadeIn + totalHold + totalFadeOut))}）`
    )
  }

  lines.push('')
  lines.push('—— 由剧场灯光 Cue 表编排器（gbcuesheet）生成 ——')
  return lines.join('\n')
}
