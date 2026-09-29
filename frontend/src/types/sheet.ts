import type { FixturePosition, FixtureType } from '@/types/fixture'
import type { CueTrigger } from '@/types/cue'

/** 排演表中的一行通道明细（生成时快照，便于历史留档） */
export interface SheetChannelLine {
  channel: number
  position: FixturePosition
  fixtureType: FixtureType
  gel: string
  intensity: number
  colorTempK: number
  focusNote: string
}

/** 排演表中的一条 Cue 条目 */
export interface SheetCueLine {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  fadeOutSec: number
  holdSec: number
  note: string
  channels: SheetChannelLine[]
}

/** 排演表类型：单场排演 / 整场联排 */
export const SHEET_KINDS = ['session', 'runthrough'] as const
export type SheetKind = (typeof SHEET_KINDS)[number]

/** 整场联排的锚定方式：从总开场连排 / 按各场计划时刻接表 */
export const RUN_ANCHOR_MODES = ['chain', 'planned'] as const
export type RunAnchorMode = (typeof RUN_ANCHOR_MODES)[number]

/** 锚定方式展示名 */
export const RUN_ANCHOR_MODE_LABELS: Record<RunAnchorMode, string> = {
  chain: '从总开场连排',
  planned: '按各场计划时刻接表'
}

/** 联排时间线提示类型：冲突（越过下一场）/ 等待（两场间空档）/ 待补（缺计划时刻） */
export type RunFlagKind = 'conflict' | 'wait' | 'pending'

/** 联排时间线上的一条提示 */
export interface RunFlag {
  kind: RunFlagKind
  /** 说明文本，例如「越过下一场计划开场 1m20s（…）」 */
  message: string
}

/** 联排表中的一条 Cue 时间线条目（生成时快照） */
export interface RunCueLine {
  cueId: string
  cueNo: string
  label: string
  trigger: CueTrigger
  fadeInSec: number
  holdSec: number
  fadeOutSec: number
  /** 总时长：渐亮 + 保持 + 渐暗（秒） */
  totalSec: number
  /** 起始时刻（自当日 00:00 起秒数，可超过 86400 表示次日）；待补为 null */
  startSec: number | null
  /** 结束时刻，规则同上 */
  endSec: number | null
  note: string
}

/** 联排表中的一个场次段落 */
export interface RunSection {
  sessionId: string
  sessionOrder: number
  sessionTitle: string
  scriptPage: string
  plannedStart: string
  plannedEnd: string
  /** 段落推算起止；缺计划时刻为 null */
  startSec: number | null
  endSec: number | null
  cueLines: RunCueLine[]
  /** 段落级提示：越过下一场的冲突、与下一场的空档、缺计划时刻 */
  flags: RunFlag[]
}

/** 被跳过的空场（无 Cue，不入时间线） */
export interface RunSkippedSession {
  sessionId: string
  sessionOrder: number
  sessionTitle: string
}

/** 整场联排的时间线快照 */
export interface RunSheetSnapshot {
  anchorMode: RunAnchorMode
  /** 总开场锚点（chain 模式取第一个非空场次的计划开场）；待补为 null */
  anchorSec: number | null
  sections: RunSection[]
  skippedSessions: RunSkippedSession[]
  /** 全程起止（首段开场 ~ 末段收尾）；无法推算为 null */
  startSec: number | null
  endSec: number | null
  /** 全部 Cue 的时长合计（秒） */
  totalSec: number
  cueCount: number
  sessionCount: number
  /** 全场级提示（如总开场待补） */
  flags: RunFlag[]
}

/** 排演表（RehearsalSheet）：单场由勾选 Cue 组合，整场联排按场次顺序串联非空场次 */
export interface RehearsalSheet {
  /** 主键 */
  id: string
  /** 表类型（v3 起；旧数据迁移为 `session`） */
  kind: SheetKind
  /** 所属场次；整场联排不属于单一场次，为 null */
  sessionId: string | null
  /** 排演表编号，单场形如 `RS-20250925-01`，联排形如 `RT-20250925-01` */
  sheetNo: string
  /** 生成时间，ISO 字符串 */
  generatedAt: string
  /** 生成时包含的 Cue id 列表 */
  includedCueIds: string[]
  /** 制表备注 */
  note: string
  /** 单场排演的条目快照（联排表为空数组） */
  cueLines: SheetCueLine[]
  /** 整场联排的时间线快照（单场排演为 null） */
  run: RunSheetSnapshot | null
}

/** 生成单场排演表时提交的字段集合 */
export interface SheetDraft {
  sessionId: string
  cueIds: string[]
  note: string
}

/** 生成整场联排表时提交的字段集合 */
export interface RunSheetDraft {
  anchorMode: RunAnchorMode
  note: string
}
