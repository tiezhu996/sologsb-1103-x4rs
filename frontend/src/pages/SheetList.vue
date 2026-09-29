<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCheckbox,
  NInput,
  NModal,
  NRadioButton,
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
import type { RehearsalSheet, RunAnchorMode, RunSheetSnapshot } from '@/types/sheet'
import { RUN_ANCHOR_MODE_LABELS } from '@/types/sheet'
import { buildSheetText, cueTotalSeconds, formatDateTime, formatSeconds } from '@/utils/fade'
import { buildRunSheetText, countRunFlags, formatClock } from '@/utils/runSheet'
import { buildSheetFilename, copyText, downloadTextFile } from '@/utils/export'

const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const sessionStore = useSessionStore()
const cueStore = useCueStore()
const sheetStore = useSheetStore()

const showAllSessions = ref(false)
const note = ref('')
const previewSheet = ref<RehearsalSheet | null>(null)

const runAnchorMode = ref<RunAnchorMode>('planned')
const runNote = ref('')

const selectedSessionId = computed(() => sessionStore.currentSessionId ?? '')

const sessionOptions = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ label: `${session.order}. ${session.title}`, value: session.id }))
)

const cues = computed(() => (selectedSessionId.value ? cueStore.sortedCuesOfSession(selectedSessionId.value) : []))
const selectedCount = computed(() => cues.value.filter((cue) => cueStore.isSelected(cue.id)).length)

/** 整场联排输入：按场次顺序的全部场次及其 Cue */
const runInputs = computed(() =>
  sessionStore.sortedSessions.map((session) => ({ session, cues: cueStore.sortedCuesOfSession(session.id) }))
)
const runnableSessions = computed(() => runInputs.value.filter((input) => input.cues.length > 0))
const runnableCueCount = computed(() => runnableSessions.value.reduce((sum, input) => sum + input.cues.length, 0))
const skippedSessions = computed(() => runInputs.value.filter((input) => input.cues.length === 0).map((input) => input.session))

/** 历史列表：联排表属于全剧始终显示，单场表按开关过滤 */
const sheets = computed(() =>
  sheetStore.sheetsSorted.filter(
    (sheet) => sheet.kind === 'runthrough' || showAllSessions.value || sheet.sessionId === selectedSessionId.value
  )
)

const previewText = computed(() => {
  if (!previewSheet.value) return ''
  return sheetTextOf(previewSheet.value)
})

function handleSessionChange(value: string | number | Array<string | number> | null): void {
  if (typeof value === 'string') sessionStore.setCurrentSession(value)
}

function handleShowAll(value: string | number | boolean): void {
  showAllSessions.value = value === true
}

function handleAnchorModeChange(value: string | number | boolean): void {
  if (value === 'chain' || value === 'planned') runAnchorMode.value = value
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

async function generateRunSheet(): Promise<void> {
  const created = await sheetStore.createRunSheet(
    { anchorMode: runAnchorMode.value, note: runNote.value.trim() },
    sessionStore.sortedSessions
  )
  if (!created || !created.run) {
    message.warning('没有可串联的非空场次，请先为场次插入 Cue')
    return
  }
  const counts = countRunFlags(created.run)
  const flagTotal = counts.conflict + counts.wait + counts.pending
  const extra = flagTotal > 0 ? `（冲突 ${counts.conflict} · 等待 ${counts.wait} · 待补 ${counts.pending}）` : ''
  message.success(`已生成 ${created.sheetNo}：${created.run.sessionCount} 个场次 · ${created.run.cueCount} 条 Cue${extra}`)
  runNote.value = ''
}

/** 按表类型拼装预览 / 导出文本 */
function sheetTextOf(sheet: RehearsalSheet): string {
  if (sheet.kind === 'runthrough' && sheet.run) return buildRunSheetText(sheet)
  const session = sheet.sessionId ? sessionStore.sessionById(sheet.sessionId) : null
  return buildSheetText(sheet, session ?? undefined)
}

function sheetTitle(sheet: RehearsalSheet): string {
  if (sheet.kind === 'runthrough') return `整场联排（${sheet.run?.sessionCount ?? 0} 个场次）`
  const session = sheet.sessionId ? sessionStore.sessionById(sheet.sessionId) : null
  return session ? `${session.order}. ${session.title}` : '（场次已删除）'
}

function cueNoSummary(sheet: RehearsalSheet): string {
  if (sheet.kind === 'runthrough' && sheet.run) {
    const numbers = sheet.run.sections.flatMap((section) => section.cueLines.map((line) => line.cueNo))
    if (numbers.length > 12) return `${numbers.slice(0, 12).join('、')} …（共 ${numbers.length} 条）`
    return numbers.join('、')
  }
  return sheet.cueLines.map((line) => line.cueNo).join('、')
}

function totalOf(sheet: RehearsalSheet): string {
  if (sheet.kind === 'runthrough' && sheet.run) return formatSeconds(sheet.run.totalSec)
  const total = sheet.cueLines.reduce(
    (sum, line) => sum + cueTotalSeconds({ fadeInSec: line.fadeInSec, holdSec: line.holdSec, fadeOutSec: line.fadeOutSec }),
    0
  )
  return formatSeconds(total)
}

/** 联排表卡片的全程时刻范围 */
function runClockRange(run: RunSheetSnapshot): string {
  return `${formatClock(run.startSec)} ~ ${formatClock(run.endSec)}`
}

/** 联排表卡片的提示汇总；无提示时返回空串 */
function runFlagSummary(run: RunSheetSnapshot): string {
  const counts = countRunFlags(run)
  const parts: string[] = []
  if (counts.conflict > 0) parts.push(`冲突 ${counts.conflict}`)
  if (counts.wait > 0) parts.push(`等待 ${counts.wait}`)
  if (counts.pending > 0) parts.push(`待补 ${counts.pending}`)
  return parts.join(' · ')
}

async function handleCopy(sheet: RehearsalSheet): Promise<void> {
  const ok = await copyText(sheetTextOf(sheet))
  if (ok) message.success('排演表文本已复制到剪贴板')
  else message.error('复制失败，请改用下载')
}

function handleDownload(sheet: RehearsalSheet): void {
  downloadTextFile(buildSheetFilename(sheet.sheetNo, sheet.generatedAt), sheetTextOf(sheet))
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
</script>

<template>
  <div class="page">
    <header class="page__header">
      <div>
        <h1 class="page__title">排演表生成与导出</h1>
        <p class="page__subtitle">
          按场次顺序串联整场联排表，或勾选单场 Cue 组表；历史本地留存，可预览、复制或导出纯文本。
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
        <h2 class="panel__title">整场联排<span class="panel__title-tag">按场次顺序串联非空场次，时间线随最新 Cue 重算</span></h2>

        <div class="run-toolbar">
          <NRadioGroup :value="runAnchorMode" size="small" @update:value="handleAnchorModeChange">
            <NRadioButton value="chain">从总开场连排</NRadioButton>
            <NRadioButton value="planned">按各场计划时刻接表</NRadioButton>
          </NRadioGroup>
          <span class="muted run-toolbar__summary">
            将串联 {{ runnableSessions.length }} 个非空场次 · 共 {{ runnableCueCount }} 条 Cue
            <template v-if="skippedSessions.length > 0">（跳过 {{ skippedSessions.length }} 个空场）</template>
          </span>
        </div>

        <div class="sheet-generate">
          <NInput v-model:value="runNote" placeholder="制表备注，例如「整场技术联排 第 1 版」" style="max-width: 420px" />
          <NButton type="primary" :disabled="runnableSessions.length === 0" @click="generateRunSheet">
            生成整场联排表
          </NButton>
        </div>

        <p class="run-hint">
          连排从第一个非空场次的计划开场连续走表；按计划时刻接表时，越过下一场记冲突、两场间空档记等待、缺计划时刻记待补。
        </p>
      </section>

      <section class="panel">
        <h2 class="panel__title">单场排演 · 选择 Cue<span class="panel__title-tag">勾选集合跨页保存在 cueStore</span></h2>

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
          <NButton type="primary" :disabled="selectedCount === 0" @click="generateSheet">生成单场排演表</NButton>
        </div>
      </section>

      <section class="panel">
        <div class="sheet-history-head">
          <h2 class="panel__title">历史排演表<span class="panel__title-tag">共 {{ sheets.length }} 张 · 联排表不受场次筛选影响</span></h2>
          <span class="sheet-history-head__switch">
            <span class="muted">显示全部场次</span>
            <NSwitch :value="showAllSessions" size="small" @update:value="(value) => handleShowAll(value)" />
          </span>
        </div>

        <BlankHint
          v-if="sheets.length === 0"
          title="还没有生成过排演表"
          description="点击「生成整场联排表」串联全剧，或勾选 Cue 后「生成单场排演表」，历史记录会保存在浏览器本地。"
          tip="排演表以生成时的快照留档，之后调整顺序或删除 Cue 不影响历史；重新生成即按最新内容重算时间线。"
        />

        <div v-else class="sheet-list">
          <article v-for="sheet in sheets" :key="sheet.id" class="sheet-card">
            <div class="sheet-card__head">
              <span class="sheet-card__no mono">{{ sheet.sheetNo }}</span>
              <NTag size="tiny" :bordered="false" :type="sheet.kind === 'runthrough' ? 'info' : 'warning'">
                {{ sheet.kind === 'runthrough' ? '整场联排' : '单场排演' }}
              </NTag>
              <span class="sheet-card__session">{{ sheetTitle(sheet) }}</span>
              <span class="toolbar__spacer" />
              <span class="sheet-card__time mono">{{ formatDateTime(sheet.generatedAt) }}</span>
            </div>

            <p class="sheet-card__cues mono">{{ cueNoSummary(sheet) || '（空表）' }}</p>

            <div class="sheet-card__meta">
              <template v-if="sheet.kind === 'runthrough' && sheet.run">
                <span>{{ RUN_ANCHOR_MODE_LABELS[sheet.run.anchorMode] }}</span>
                <span>全程 {{ runClockRange(sheet.run) }}</span>
                <span>Cue {{ sheet.run.cueCount }} 条 · 过渡合计 {{ totalOf(sheet) }}</span>
                <span v-if="runFlagSummary(sheet.run)" class="sheet-card__flags">{{ runFlagSummary(sheet.run) }}</span>
              </template>
              <template v-else>
                <span>Cue {{ sheet.cueLines.length }} 条</span>
                <span>过渡合计 {{ totalOf(sheet) }}</span>
              </template>
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
      :title="previewSheet ? `${previewSheet.kind === 'runthrough' ? '整场联排表预览' : '排演表预览'} · ${previewSheet.sheetNo}` : '排演表预览'"
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
.run-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.run-toolbar__summary {
  font-size: 12px;
}

.run-hint {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.4);
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

.sheet-card__flags {
  color: #f0a35e;
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
