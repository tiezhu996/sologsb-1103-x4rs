import type { FixturePosition, FixtureType } from '@/types/fixture'
import type { CueTrigger } from '@/types/cue'

/** 排演表类型：单场排演表 / 整场联排表 */
export type SheetKind = 'single' | 'run'

/** 联排时刻锚定方式：总开场连排 / 按各场计划时刻接表 */
export type RunAnchorMode = 'continuous' | 'planned'

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
  /** 联排表快照：所属场次 id（单场表无此字段） */
  sessionId?: string
  /** 联排表快照：开场时刻（当日 0 点起秒数）；无法锚定时为 null */
  clockStartSec?: number | null
  /** 联排表快照：结束时刻（当日 0 点起秒数）；无法锚定时为 null */
  clockEndSec?: number | null
}

/** 联排表中两场之间的衔接提示（生成时冻结） */
export interface SheetRunMarker {
  /** 衔接的上一场次 id */
  fromSessionId: string
  /** 衔接的下一场次 id */
  toSessionId: string
  /** 等待（两场间有空档）/ 冲突（上一场越过下一场计划开场）/ 待补（计划时刻缺失） */
  type: 'wait' | 'conflict' | 'pending'
  /** 差额秒数：wait 为等待时长，conflict 为越界时长；pending 时为 null */
  deltaSec: number | null
  /** 生成时冻结的说明文本 */
  text: string
}

/** 联排表中的一个场次块（生成时快照） */
export interface SheetRunSession {
  sessionId: string
  /** 场次演出顺序 */
  order: number
  title: string
  scriptPage: string
  plannedStart: string
  plannedEnd: string
  stageNote: string
  /** 该块计划时刻缺失、无法锚定（时刻标待补） */
  pending: boolean
  cueLines: SheetCueLine[]
}

/** 排演表（RehearsalSheet）：勾选 Cue 组合出的可导出表，或整场联排快照 */
export interface RehearsalSheet {
  /** 主键 */
  id: string
  /** 表类型：单场 / 联排，旧表迁移后均为 'single' */
  kind: SheetKind
  /** 单场表：所属场次；联排表：首场 id（兼容旧的场次级联清理） */
  sessionId: string
  /** 联排表包含的全部场次 id（按演出顺序）；单场表为空数组 */
  sessionIds: string[]
  /** 排演表编号，形如 `RS-20250925-01` */
  sheetNo: string
  /** 生成时间，ISO 字符串 */
  generatedAt: string
  /** 生成时勾选的 Cue id 列表 */
  includedCueIds: string[]
  /** 制表备注 */
  note: string
  /** 单场表的条目快照；联排表为各场条目按顺序拼成的扁平列表 */
  cueLines: SheetCueLine[]
  /** 联排表：时刻锚定方式 */
  runAnchorMode?: RunAnchorMode
  /** 联排表：总开场时刻（`HH:mm`，仅总开场连排模式有值） */
  runStart?: string
  /** 联排表：按场次分块的快照 */
  runSessions?: SheetRunSession[]
  /** 联排表：场次之间的等待 / 冲突 / 待补标记 */
  runMarkers?: SheetRunMarker[]
}

/** 生成单场排演表时提交的字段集合 */
export interface SheetDraft {
  sessionId: string
  cueIds: string[]
  note: string
}

/** 生成整场联排表时提交的字段集合 */
export interface RunSheetDraft {
  /** 参与联排的场次 id（按演出顺序、非空场次） */
  sessionIds: string[]
  /** 时刻锚定方式 */
  anchorMode: RunAnchorMode
  /** 总开场时刻（`HH:mm`，仅总开场连排模式使用） */
  runStart: string
  note: string
}
