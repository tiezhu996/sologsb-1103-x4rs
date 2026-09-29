<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NRadio,
  NRadioGroup,
  NSelect,
  NSwitch,
  NTag,
  useDialog,
  useMessage
} from 'naive-ui'
import BlankHint from '@/components/common/BlankHint.vue'
import { useCueStore } from '@/stores/cueStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSheetStore } from '@/stores/sheetStore'
import type { RehearsalSheet, RunAnchorMode } from '@/types/sheet'
import { buildSheetText, cueTotalSeconds, formatDateTime, formatSeconds } from '@/utils/fade'
import { buildSheetFilename, copyText, downloadTextFile } from '@/utils/export'
import { buildRunTimeline, formatClock, type RunMarkerType } from '@/utils/runTimeline'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const sheetStore = useSheetStore()

const showAllSessions = ref(false)
const note = ref('')
const previewSheet = ref<RehearsalSheet | null>(null)

/** 排演表生成模式：单场 / 整场联排 */
const sheetMode = ref<'single' | 'run'>('single')

/** 联排设置 */
const runAnchorMode = ref<RunAnchorMode>('continuous')
const runStart = ref('')
const runSessionIds = ref<string[]>([])
const runNote = ref('')
const runSessionsInitialized = ref(false)

const selectedSessionId = computed(() => sessionStore.currentSessionId ?? '')

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const cues = computed(() => (selectedSessionId.value ? cueStore.sortedCuesOfSession(selectedSessionId.value) : []))
const selectedCount = computed(() => cues.value.filter((cue) => cueStore.isSelected(cue.id)).length)

const sheets = computed(() =>
  showAllSessions.value ? sheetStore.sheetsSorted : sheetStore.sheetsOfSession(selectedSessionId.value)
)

/** 联排候选场次：非空场次按演出顺序 */
const runSessions = computed(() =>
  sessionStore.sortedSessions.filter((session) => cueStore.sortedCuesOfSession(session.id).length > 0)
)
/** 没有 Cue、被跳过的场次 */
const emptyRunSessions = computed(() =>
  sessionStore.sortedSessions.filter((session) => cueStore.sortedCuesOfSession(session.id).length === 0)
)

/** 勾选参与联排的场次（按演出顺序） */
const pickedRunSessions = computed(() =>
  runSessions.value.filter((session) => runSessionIds.value.includes(session.id))
)

/** 联排时间线实时预览：场次调序、Cue 增删改后自动重算 */
const runTimeline = computed(() => {
  const cuesBySession = new Map(
    pickedRunSessions.value.map((session) => [session.id, cueStore.sortedCuesOfSession(session.id)])
  )
  return buildRunTimeline(pickedRunSessions.value, cuesBySession, runAnchorMode.value, runStart.value.trim())
})

const runCueCount = computed(() => runTimeline.value.blocks.reduce((sum, block) => sum + block.cues.length, 0))

const previewText = computed(() => {
  if (!previewSheet.value) return ''
  return buildSheetText(previewSheet.value, sessionStore.sessionById(previewSheet.value.sessionId) ?? undefined)
})

const markerMeta: Record<RunMarkerType, { label: string; type: 'info' | 'error' | 'warning' }> = {
  wait: { label: '等待', type: 'info' },
  conflict: { label: '冲突', type: 'error' },
  pending: { label: '待补', type: 'warning' }
}

function markerOf(sessionId: string) {
  return runTimeline.value.markers.find((marker) => marker.fromSessionId === sessionId) ?? null
}

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') sessionStore.setCurrentSession(value)
}

function handleShowAll(value: string | number | boolean): void {
  showAllSessions.value = value === true
}

function selectAll(): void {
  cueStore.setSelection(cues.value.map((cue) => cue.id))
}

function invertSelection(): void {
  cueStore.setSelection(cues.value.filter((cue) => !cueStore.isSelected(cue.id)).map((cue) => cue.id))
}

function clearSelection(): void {
  cueStore.clearSelection()
}

async function generateSheet(): Promise<void> {
  if (!selectedSessionId.value) {
    message.warning('请先选择场次')
    return
  }
  if (selectedCount.value === 0) {
    message.warning('请至少勾选一条 Cue')
    return
  }
  const created = await sheetStore.createSheet({
    sessionId: selectedSessionId.value,
    cueIds: cues.value.filter((cue) => cueStore.isSelected(cue.id)).map((cue) => cue.id),
    note: note.value.trim()
  })
  if (!created) {
    message.error('生成失败：勾选的 Cue 已不存在')
    return
  }
  message.success(`已生成 ${created.sheetNo}，包含 ${created.cueLines.length} 条 Cue`)
  note.value = ''
  cueStore.clearSelection()
}

function toggleRunSession(sessionId: string, checked: boolean): void {
  runSessionIds.value = checked
    ? [...runSessionIds.value, sessionId]
    : runSessionIds.value.filter((id) => id !== sessionId)
}

async function generateRunSheet(): Promise<void> {
  if (pickedRunSessions.value.length === 0) {
    message.warning('请至少勾选一个非空场次')
    return
  }
  const created = await sheetStore.createRunSheet({
    sessionIds: pickedRunSessions.value.map((session) => session.id),
    anchorMode: runAnchorMode.value,
    runStart: runStart.value.trim(),
    note: runNote.value.trim()
  })
  if (!created) {
    message.error('生成失败：勾选的场次都没有 Cue')
    return
  }
  message.success(
    `已生成 ${created.sheetNo}：${created.runSessions?.length ?? 0} 场、${created.cueLines.length} 条 Cue`
  )
  runNote.value = ''
}

function sheetTitle(sheet: RehearsalSheet): string {
  if (sheet.kind === 'run') return `联排 · ${sheet.sessionIds.length} 场`
  const session = sessionStore.sessionById(sheet.sessionId)
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

function runAnchorText(sheet: RehearsalSheet): string {
  return sheet.runAnchorMode === 'planned' ? '按计划时刻接表' : '总开场连排'
}

function cueNoSummary(sheet: RehearsalSheet): string {
  return sheet.cueLines.map((line) => line.cueNo).join('、')
}

function totalOf(sheet: RehearsalSheet): string {
  const total = sheet.cueLines.reduce(
    (sum, line) => sum + cueTotalSeconds({ fadeInSec: line.fadeInSec, holdSec: line.holdSec, fadeOutSec: line.fadeOutSec }),
    0
  )
  return formatSeconds(total)
}

async function handleCopy(sheet: RehearsalSheet): Promise<void> {
  const ok = await copyText(buildSheetText(sheet, sessionStore.sessionById(sheet.sessionId) ?? undefined))
  if (ok) message.success('排演表文本已复制到剪贴板')
  else message.error('复制失败，请改用下载')
}

function handleDownload(sheet: RehearsalSheet): void {
  downloadTextFile(buildSheetFilename(sheet.sheetNo, sheet.generatedAt), buildSheetText(sheet, sessionStore.sessionById(sheet.sessionId) ?? undefined))
  message.success('已导出纯文本排演表')
}

function confirmRemove(sheet: RehearsalSheet): void {
  dialog.warning({
    title: '删除排演表',
    content: `将删除 ${sheet.sheetNo}（生成于 ${formatDateTime(sheet.generatedAt)}），不影响场次与 Cue。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      await sheetStore.removeSheet(sheet.id)
      message.success('排演表已删除')
    }
  })
}

function goCues(): void {
  if (!selectedSessionId.value) {
    void router.push('/sessions')
    return
  }
  void router.push(`/sessions/${selectedSessionId.value}/cues`)
}

function goSessions(): void {
  void router.push('/sessions')
}

/** 切到联排模式时默认全选非空场次，并带出总开场时刻 */
watch(sheetMode, (mode) => {
  if (mode !== 'run') return
  if (!runSessionsInitialized.value) {
    runSessionIds.value = runSessions.value.map((session) => session.id)
    runSessionsInitialized.value = true
  }
  if (!runStart.value) runStart.value = runSessions.value[0]?.plannedStart ?? ''
})

/** 场次增删后同步勾选：新增非空场次默认勾上，已删除 / 清空的场次移除 */
watch(runSessions, (sessions) => {
  if (!runSessionsInitialized.value) return
  const current = new Set(sessions.map((session) => session.id))
  runSessionIds.value = runSessionIds.value.filter((id) => current.has(id))
  sessions.forEach((session) => {
    if (!runSessionIds.value.includes(session.id)) runSessionIds.value.push(session.id)
  })
})
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">排演表生成与导出</h1>
        <p class="page__subtitle">
          勾选 Cue 组合单场排演表，或把非空场次按演出顺序串成整场联排表；历史表本地留存，可预览、复制或导出纯文本。
        </p>
      </div>
      <div class="page__actions">
        <NButton @click="goSessions">场次编排</NButton>
        <NButton @click="goCues">Cue 时间轴</NButton>
      </div>
    </header>

    <NAlert v-if="sessionStore.sortedSessions.length === 0" type="info" :bordered="false">
      还没有场次。请先在场次编排中创建场次并插入 Cue，再来生成排演表。
    </NAlert>

    <template v-else>
      <section class="panel">
        <h2 class="panel__title">
          生成排演表
          <span class="panel__title-tag">单场表勾选 Cue · 联排表串起非空场次</span>
        </h2>

        <NRadioGroup v-model:value="sheetMode" size="small" class="sheet-mode-switch">
          <NRadio value="single">单场排演表</NRadio>
          <NRadio value="run">整场联排表</NRadio>
        </NRadioGroup>

        <!-- 单场排演表 -->
        <template v-if="sheetMode === 'single'">
          <div class="sheet-toolbar">
            <NSelect
              :value="selectedSessionId || null"
              :options="sessionOptions"
              placeholder="选择场次"
              style="width: 260px"
              @update:value="handleSessionChange"
            />
            <NButton size="small" @click="selectAll">全选本场</NButton>
            <NButton size="small" @click="invertSelection">反选</NButton>
            <NButton size="small" quaternary @click="clearSelection">清空勾选</NButton>
            <span class="toolbar__spacer" />
            <NTag size="small" :bordered="false" type="warning">
              已勾选 {{ selectedCount }} / {{ cues.length }}
            </NTag>
          </div>

          <div v-if="cues.length === 0" class="sheet-empty">
            <BlankHint
              title="本场还没有 Cue"
              description="排演表由 Cue 组合而成。先到 Cue 编排时间轴插入提示点，再回来勾选生成。"
              action-text="去插入 Cue"
              @action="goCues"
            />
          </div>

          <div v-else class="cue-select-list">
            <label
              v-for="cue in cues"
              :key="cue.id"
              class="cue-select"
              :class="{ 'cue-select--checked': cueStore.isSelected(cue.id) }"
            >
              <NCheckbox :checked="cueStore.isSelected(cue.id)" @update:checked="() => cueStore.toggleSelected(cue.id)" />
              <span class="cue-select__no mono">{{ cue.cueNo }}</span>
              <span class="cue-select__label">{{ cue.label || '（未填写提示语）' }}</span>
              <NTag size="tiny" :bordered="false">{{ cue.trigger }}</NTag>
              <span class="cue-select__duration mono">{{ formatSeconds(cueTotalSeconds(cue)) }}</span>
            </label>
          </div>

          <div class="sheet-generate">
            <NInput v-model:value="note" placeholder="制表备注，例如「技术合成第 2 版」" style="max-width: 420px" />
            <NButton type="primary" :disabled="selectedCount === 0" @click="generateSheet">生成排演表</NButton>
          </div>
        </template>

        <!-- 整场联排表 -->
        <template v-else>
          <div class="run-anchor">
            <NRadioGroup v-model:value="runAnchorMode" size="small">
              <NRadio value="continuous">总开场连排（首尾相接，不看各场计划时刻）</NRadio>
              <NRadio value="planned">按各场计划时刻接表（空档记等待、越场记冲突）</NRadio>
            </NRadioGroup>
            <NInput
              v-if="runAnchorMode === 'continuous'"
              v-model:value="runStart"
              placeholder="总开场时刻，例如 19:00"
              style="max-width: 220px"
            />
          </div>

          <p class="run-section-label">
            参与联排的场次
            <span class="muted">（按演出顺序串起非空场次，可勾选排除）</span>
          </p>

          <div v-if="runSessions.length === 0" class="sheet-empty">
            <BlankHint
              title="还没有非空场次"
              description="联排表按场次顺序串起有 Cue 的场次。先到场次编排建场并插入 Cue，再回来生成。"
              action-text="去场次编排"
              @action="goSessions"
            />
          </div>

          <template v-else>
            <div class="run-session-list">
              <label
                v-for="session in runSessions"
                :key="session.id"
                class="run-session"
                :class="{ 'run-session--checked': runSessionIds.includes(session.id) }"
              >
                <NCheckbox
                  :checked="runSessionIds.includes(session.id)"
                  @update:checked="(checked) => toggleRunSession(session.id, checked)"
                />
                <span class="run-session__order mono">{{ session.order }}</span>
                <span class="run-session__title">{{ session.title }}</span>
                <span class="run-session__plan mono">
                  {{ session.plannedStart || '待补' }} ~ {{ session.plannedEnd || '待补' }}
                </span>
                <span class="toolbar__spacer" />
                <span class="muted">{{ cueStore.sortedCuesOfSession(session.id).length }} 条 Cue</span>
              </label>
            </div>

            <p v-if="emptyRunSessions.length > 0" class="run-session-hint">
              以下 {{ emptyRunSessions.length }} 个场次没有 Cue，已自动跳过：{{
                emptyRunSessions.map((session) => `${session.order}. ${session.title}`).join('、')
              }}
            </p>

            <div class="run-summary">
              <NTag size="small" :bordered="false" type="warning">
                {{ pickedRunSessions.length }} 场 · {{ runCueCount }} 条 Cue
              </NTag>
              <NTag v-if="runTimeline.pendingCount > 0" size="small" :bordered="false" type="warning">
                {{ runTimeline.pendingCount }} 场时刻待补
              </NTag>
              <span class="muted">过渡合计 {{ formatSeconds(runTimeline.totalSec) }}</span>
            </div>

            <div class="run-timeline">
              <div v-for="block in runTimeline.blocks" :key="block.session.id">
                <div class="run-block">
                  <div class="run-block__head">
                    <span class="run-block__order mono">{{ block.session.order }}</span>
                    <span class="run-block__title">{{ block.session.title }}</span>
                    <span class="run-block__plan mono">
                      计划 {{ block.session.plannedStart || '待补' }} ~ {{ block.session.plannedEnd || '待补' }}
                    </span>
                    <NTag v-if="block.pending" size="tiny" type="warning" :bordered="false">时刻待补</NTag>
                    <span class="toolbar__spacer" />
                    <span class="muted">{{ block.cues.length }} 条</span>
                  </div>
                  <div class="run-cue-list">
                    <div v-for="item in block.cues" :key="item.cue.id" class="run-cue">
                      <span class="run-cue__no mono">{{ item.cue.cueNo }}</span>
                      <span class="run-cue__label">{{ item.cue.label || '（未填写提示语）' }}</span>
                      <NTag size="tiny" :bordered="false">{{ item.cue.trigger }}</NTag>
                      <span class="toolbar__spacer" />
                      <span class="run-cue__clock mono">{{ formatClock(item.startSec) }} ~ {{ formatClock(item.endSec) }}</span>
                      <span class="run-cue__dur mono">{{ formatSeconds(cueTotalSeconds(item.cue)) }}</span>
                    </div>
                  </div>
                </div>

                <div v-if="markerOf(block.session.id)" class="run-marker" :class="`run-marker--${markerOf(block.session.id)?.type}`">
                  <NTag size="tiny" :bordered="false" :type="markerMeta[markerOf(block.session.id)!.type].type">
                    {{ markerMeta[markerOf(block.session.id)!.type].label }}
                  </NTag>
                  <span class="run-marker__text">{{ markerOf(block.session.id)?.text }}</span>
                </div>
              </div>
            </div>

            <div class="sheet-generate">
              <NInput v-model:value="runNote" placeholder="制表备注，例如「技术合成第 2 版」" style="max-width: 420px" />
              <NButton type="primary" :disabled="pickedRunSessions.length === 0" @click="generateRunSheet">
                生成联排表
              </NButton>
            </div>
          </template>
        </template>
      </section>

      <section class="panel">
        <div class="sheet-history-head">
          <h2 class="panel__title">历史排演表<span class="panel__title-tag">共 {{ sheets.length }} 张</span></h2>
          <span class="sheet-history-head__switch">
            <span class="muted">显示全部场次</span>
            <NSwitch :value="showAllSessions" size="small" @update:value="(value) => handleShowAll(value)" />
          </span>
        </div>

        <BlankHint
          v-if="sheets.length === 0"
          title="还没有生成过排演表"
          description="勾选上半部分的 Cue（或串好联排场次）后点击生成，历史记录会保存在浏览器本地。"
          tip="排演表以生成时的场次、时刻与电平快照留档，之后调整 Cue 不影响历史。"
        />

        <div v-else class="sheet-list">
          <article v-for="sheet in sheets" :key="sheet.id" class="sheet-card">
            <div class="sheet-card__head">
              <NTag size="tiny" :type="sheet.kind === 'run' ? 'warning' : 'default'" :bordered="false">
                {{ sheet.kind === 'run' ? '联排' : '单场' }}
              </NTag>
              <span class="sheet-card__no mono">{{ sheet.sheetNo }}</span>
              <span class="sheet-card__session">{{ sheetTitle(sheet) }}</span>
              <span class="toolbar__spacer" />
              <span class="sheet-card__time mono">{{ formatDateTime(sheet.generatedAt) }}</span>
            </div>

            <p class="sheet-card__cues mono">{{ cueNoSummary(sheet) || '（空表）' }}</p>

            <div class="sheet-card__meta">
              <span>Cue {{ sheet.cueLines.length }} 条</span>
              <template v-if="sheet.kind === 'run'">
                <span>场次 {{ sheet.runSessions?.length ?? 0 }} 个</span>
                <span>{{ runAnchorText(sheet) }}</span>
                <span v-for="marker in sheet.runMarkers" :key="`${marker.type}-${marker.toSessionId}`">
                  {{ markerMeta[marker.type].label }} {{ marker.deltaSec !== null ? formatSeconds(marker.deltaSec) : '待补' }}
                </span>
              </template>
              <span>过渡合计 {{ totalOf(sheet) }}</span>
              <span v-if="sheet.note">备注：{{ sheet.note }}</span>
            </div>

            <div class="sheet-card__actions">
              <NButton size="tiny" @click="previewSheet = sheet">预览</NButton>
              <NButton size="tiny" quaternary @click="handleCopy(sheet)">复制文本</NButton>
              <NButton size="tiny" quaternary @click="handleDownload(sheet)">下载 .txt</NButton>
              <NButton size="tiny" quaternary type="error" @click="confirmRemove(sheet)">删除</NButton>
            </div>
          </article>
        </div>
      </section>
    </template>

    <NModal
      :show="previewSheet !== null"
      preset="card"
      :title="previewSheet ? `排演表预览 · ${previewSheet.sheetNo}` : '排演表预览'"
      class="preview-modal"
      @update:show="(value) => { if (!value) previewSheet = null }"
    >
      <pre class="preview-text">{{ previewText }}</pre>
      <template #footer>
        <div class="modal-footer">
          <NButton @click="previewSheet = null">关闭</NButton>
          <NButton v-if="previewSheet" quaternary @click="handleCopy(previewSheet)">复制文本</NButton>
          <NButton v-if="previewSheet" type="primary" @click="handleDownload(previewSheet)">下载 .txt</NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.sheet-mode-switch {
  margin-bottom: 14px;
}

.sheet-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sheet-empty {
  margin-top: 14px;
}

.cue-select-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 14px;
  max-height: 360px;
  overflow-y: auto;
  padding-right: 4px;
}

.cue-select {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.cue-select:hover {
  background: rgba(255, 255, 255, 0.045);
}

.cue-select--checked {
  border-color: rgba(242, 181, 68, 0.55);
  background: rgba(242, 181, 68, 0.08);
}

.cue-select__no {
  font-weight: 600;
  color: #f2b544;
  min-width: 62px;
}

.cue-select__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.cue-select__duration {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.sheet-generate {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.run-anchor {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.run-section-label {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
}

.run-session-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-session {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: border-color 0.16s ease, background 0.16s ease;
}

.run-session:hover {
  background: rgba(255, 255, 255, 0.045);
}

.run-session--checked {
  border-color: rgba(242, 181, 68, 0.55);
  background: rgba(242, 181, 68, 0.08);
}

.run-session__order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 7px;
  background: rgba(242, 181, 68, 0.14);
  color: #f2b544;
  font-weight: 600;
  font-size: 12px;
}

.run-session__title {
  font-size: 13px;
  font-weight: 600;
}

.run-session__plan {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.run-session-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.run-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 14px 0 10px;
  font-size: 12px;
}

.run-timeline {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.run-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.run-block__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.run-block__order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 7px;
  background: rgba(63, 191, 158, 0.16);
  color: #3fbf9f;
  font-weight: 600;
  font-size: 12px;
}

.run-block__title {
  font-size: 13px;
  font-weight: 600;
}

.run-block__plan {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.run-cue-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-left: 34px;
  padding-left: 12px;
  border-left: 1px dashed rgba(255, 255, 255, 0.12);
}

.run-cue {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 7px;
  font-size: 12px;
}

.run-cue:hover {
  background: rgba(255, 255, 255, 0.04);
}

.run-cue__no {
  font-weight: 600;
  color: #f2b544;
  min-width: 52px;
}

.run-cue__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.78);
}

.run-cue__clock {
  color: #3fbf9f;
  font-size: 12px;
  white-space: nowrap;
}

.run-cue__dur {
  color: rgba(255, 255, 255, 0.45);
  font-size: 11px;
  min-width: 52px;
  text-align: right;
}

.run-marker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 8px 34px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.run-marker--wait {
  background: rgba(99, 179, 237, 0.1);
  border: 1px solid rgba(99, 179, 237, 0.3);
  color: #a8d4f5;
}

.run-marker--conflict {
  background: rgba(232, 84, 84, 0.1);
  border: 1px solid rgba(232, 84, 84, 0.32);
  color: #ff9a9a;
}

.run-marker--pending {
  background: rgba(242, 181, 68, 0.08);
  border: 1px solid rgba(242, 181, 68, 0.3);
  color: #f2b544;
}

.run-marker__text {
  color: rgba(255, 255, 255, 0.72);
}

.sheet-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sheet-history-head__switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.sheet-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}

.sheet-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sheet-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sheet-card__no {
  font-weight: 600;
  color: #f2b544;
}

.sheet-card__session {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
}

.sheet-card__time {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}

.sheet-card__cues {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  line-height: 1.7;
  word-break: break-all;
}

.sheet-card__meta {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.sheet-card__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.preview-modal {
  width: 720px;
  max-width: 94vw;
}

.preview-text {
  margin: 0;
  max-height: 60vh;
  overflow: auto;
  padding: 14px 16px;
  border-radius: 10px;
  background: #0b0d12;
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.75;
  white-space: pre;
  color: rgba(255, 255, 255, 0.82);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
