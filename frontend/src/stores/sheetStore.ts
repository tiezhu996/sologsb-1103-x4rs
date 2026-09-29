import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  RehearsalSheet,
  RunSheetDraft,
  SheetChannelLine,
  SheetCueLine,
  SheetDraft,
  SheetRunMarker,
  SheetRunSession
} from '@/types/sheet'
import { db } from '@/utils/db'
import { createId } from '@/utils/id'
import { sortFixturesByChannel } from '@/utils/patch'
import { buildRunTimeline } from '@/utils/runTimeline'
import { useCueStore } from '@/stores/cueStore'
import { useFixtureStore } from '@/stores/fixtureStore'
import { useLevelStore } from '@/stores/levelStore'
import { useSessionStore } from '@/stores/sessionStore'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 以生成日期 + 序号拼排演表编号 */
function buildSheetNo(sequence: number, generatedAt: Date): string {
  return `RS-${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}-${pad(sequence)}`
}

/**
 * 排演表仓库：勾选 Cue 生成条目快照并本地留存历史，
 * 也支持把若干非空场次按演出顺序串成整场联排表。
 */
export const useSheetStore = defineStore('sheet', () => {
  const sheets = ref<RehearsalSheet[]>([])
  const hydrated = ref(false)

  const sheetsSorted = computed(() =>
    [...sheets.value].sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  )

  /** 单场表按所属场次过滤；联排表按其包含的场次过滤 */
  function sheetsOfSession(sessionId: string): RehearsalSheet[] {
    return sheetsSorted.value.filter((sheet) =>
      sheet.kind === 'run' ? sheet.sessionIds.includes(sessionId) : sheet.sessionId === sessionId
    )
  }

  function sheetById(id: string): RehearsalSheet | null {
    return sheets.value.find((sheet) => sheet.id === id) ?? null
  }

  /** 下一张排演表在当天内的序号 */
  function nextSequence(generatedAt: Date): number {
    const prefix = `RS-${generatedAt.getFullYear()}${pad(generatedAt.getMonth() + 1)}${pad(generatedAt.getDate())}-`
    const used = sheets.value
      .filter((sheet) => sheet.sheetNo.startsWith(prefix))
      .map((sheet) => Number.parseInt(sheet.sheetNo.slice(prefix.length), 10))
      .filter((value) => Number.isFinite(value))
    return used.length === 0 ? 1 : Math.max(...used) + 1
  }

  async function hydrate(): Promise<void> {
    sheets.value = await db.sheets.toArray()
    hydrated.value = true
  }

  /** 组装一条 Cue 的通道电平快照 */
  function buildChannelLines(cueId: string, sessionId: string): SheetChannelLine[] {
    const fixtureStore = useFixtureStore()
    const levelStore = useLevelStore()
    return sortFixturesByChannel(fixtureStore.fixturesOfSession(sessionId))
      .map((fixture) => {
        const level = levelStore.levelOf(cueId, fixture.id)
        if (!level) return null
        return {
          channel: fixture.channel,
          position: fixture.position,
          fixtureType: fixture.fixtureType,
          gel: fixture.gel,
          intensity: level.intensity,
          colorTempK: level.colorTempK,
          focusNote: level.focusNote
        }
      })
      .filter((line): line is SheetChannelLine => line !== null)
  }

  /** 依据勾选的 Cue 组装条目快照并落库 */
  async function createSheet(draft: SheetDraft): Promise<RehearsalSheet | null> {
    const cueStore = useCueStore()

    const ordered = cueStore.sortedCuesOfSession(draft.sessionId).filter((cue) => draft.cueIds.includes(cue.id))
    if (ordered.length === 0) return null

    const cueLines: SheetCueLine[] = ordered.map((cue) => ({
      cueId: cue.id,
      cueNo: cue.cueNo,
      label: cue.label,
      trigger: cue.trigger,
      fadeInSec: cue.fadeInSec,
      fadeOutSec: cue.fadeOutSec,
      holdSec: cue.holdSec,
      note: cue.note,
      channels: buildChannelLines(cue.id, draft.sessionId)
    }))

    const generatedAt = new Date()
    const created: RehearsalSheet = {
      id: createId('sheet'),
      kind: 'single',
      sessionId: draft.sessionId,
      sessionIds: [],
      sheetNo: buildSheetNo(nextSequence(generatedAt), generatedAt),
      generatedAt: generatedAt.toISOString(),
      includedCueIds: cueLines.map((line) => line.cueId),
      note: draft.note,
      cueLines
    }
    await db.sheets.put(created)
    sheets.value = [...sheets.value, created]
    return created
  }

  /** 把若干非空场次按演出顺序串成整场联排表并落库；无 Cue 时返回 null */
  async function createRunSheet(draft: RunSheetDraft): Promise<RehearsalSheet | null> {
    const sessionStore = useSessionStore()
    const cueStore = useCueStore()

    const picked = draft.sessionIds
      .map((id) => sessionStore.sessionById(id))
      .filter((session): session is NonNullable<typeof session> => session !== null)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
    const nonEmpty = picked.filter((session) => cueStore.sortedCuesOfSession(session.id).length > 0)
    if (nonEmpty.length === 0) return null

    const cuesBySession = new Map(nonEmpty.map((session) => [session.id, cueStore.sortedCuesOfSession(session.id)]))
    const timeline = buildRunTimeline(nonEmpty, cuesBySession, draft.anchorMode, draft.runStart)

    const runSessions: SheetRunSession[] = []
    const flatCueLines: SheetCueLine[] = []
    timeline.blocks.forEach((block) => {
      const cueLines: SheetCueLine[] = block.cues.map(({ cue, startSec, endSec }) => ({
        cueId: cue.id,
        cueNo: cue.cueNo,
        label: cue.label,
        trigger: cue.trigger,
        fadeInSec: cue.fadeInSec,
        fadeOutSec: cue.fadeOutSec,
        holdSec: cue.holdSec,
        note: cue.note,
        channels: buildChannelLines(cue.id, block.session.id),
        sessionId: block.session.id,
        clockStartSec: startSec,
        clockEndSec: endSec
      }))
      runSessions.push({
        sessionId: block.session.id,
        order: block.session.order,
        title: block.session.title,
        scriptPage: block.session.scriptPage,
        plannedStart: block.session.plannedStart,
        plannedEnd: block.session.plannedEnd,
        stageNote: block.session.stageNote,
        pending: block.pending,
        cueLines
      })
      flatCueLines.push(...cueLines)
    })

    const runMarkers: SheetRunMarker[] = timeline.markers.map((marker) => ({ ...marker }))

    const generatedAt = new Date()
    const created: RehearsalSheet = {
      id: createId('sheet'),
      kind: 'run',
      sessionId: nonEmpty[0].id,
      sessionIds: nonEmpty.map((session) => session.id),
      sheetNo: buildSheetNo(nextSequence(generatedAt), generatedAt),
      generatedAt: generatedAt.toISOString(),
      includedCueIds: flatCueLines.map((line) => line.cueId),
      note: draft.note,
      cueLines: flatCueLines,
      runAnchorMode: draft.anchorMode,
      runStart: draft.anchorMode === 'continuous' ? draft.runStart.trim() : '',
      runSessions,
      runMarkers
    }
    await db.sheets.put(created)
    sheets.value = [...sheets.value, created]
    return created
  }

  async function removeSheet(id: string): Promise<void> {
    const target = sheetById(id)
    if (!target) return
    await db.sheets.delete(id)
    sheets.value = sheets.value.filter((sheet) => sheet.id !== id)
  }

  async function removeBySession(sessionId: string): Promise<void> {
    const targets = sheetsOfSession(sessionId)
    if (targets.length === 0) return
    await db.sheets.bulkDelete(targets.map((sheet) => sheet.id))
    sheets.value = sheets.value.filter((sheet) => !targets.some((target) => target.id === sheet.id))
  }

  return {
    sheets,
    hydrated,
    sheetsSorted,
    sheetsOfSession,
    sheetById,
    hydrate,
    createSheet,
    createRunSheet,
    removeSheet,
    removeBySession
  }
})
