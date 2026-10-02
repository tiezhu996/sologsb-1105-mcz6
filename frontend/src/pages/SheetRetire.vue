<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSheetStore } from '../stores/sheetStore'
import { useRetirementStore } from '../stores/retirementStore'
import type { AffectedNeighborMemento, RetirementSnapshot } from '../types/retirement'
import { onEditAnnounced } from '../utils/broadcast'
import {
  RetirementCommitError,
  RetirementStaleError,
} from '../utils/retirementService'
import {
  captureSnapshot,
  collectAffectedNeighbors,
  messageTouchesSheet,
} from '../utils/retirementSnapshot'
import { sortByPeriod } from '../utils/scale'
import { downloadJson } from '../utils/export'
import ScanCard from '../components/common/ScanCard.vue'
import PairRow from '../components/common/PairRow.vue'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const router = useRouter()
const sheetStore = useSheetStore()
const retirementStore = useRetirementStore()

const sheetId = computed(() => String(route.params.id ?? ''))
const fixing = ref(false)
const loadError = ref('')
const notFound = ref(false)
const alreadyRetired = ref(false)

const snapshot = ref<RetirementSnapshot | null>(null)
const fingerprint = ref('')
const affectedNeighbors = ref<AffectedNeighborMemento[]>([])
const stale = ref(false)
const staleSource = ref('')
const reason = ref('')
const reasonError = ref('')
const submitting = ref(false)
const failedCheckpointId = ref('')

const fixedAtText = computed(() =>
  snapshot.value ? new Date(snapshot.value.fixedAt).toLocaleString('zh-CN') : '',
)
const sortedHistories = computed(() =>
  snapshot.value ? sortByPeriod(snapshot.value.histories) : [],
)

/** 进入确认页即固定当前扫描件、地名对照与沿革清单，提交时只认这份快照 */
async function fixSnapshot(showNotice = false): Promise<void> {
  fixing.value = true
  loadError.value = ''
  stale.value = false
  staleSource.value = ''
  failedCheckpointId.value = ''
  try {
    await Promise.all([sheetStore.init(), retirementStore.init()])
    await sheetStore.loadSheet(sheetId.value)
    const existing = sheetStore.currentSheet
    if (!existing) {
      notFound.value = true
      return
    }
    notFound.value = false
    if (existing.status === '已撤编' || retirementStore.getRetirement(sheetId.value)) {
      alreadyRetired.value = true
      return
    }

    const captured = await captureSnapshot(sheetId.value)
    if (captured.snapshot.sheet.status === '已撤编') {
      alreadyRetired.value = true
      return
    }
    snapshot.value = captured.snapshot
    fingerprint.value = captured.fingerprint
    reason.value = ''

    const neighbors = await collectAffectedNeighbors(captured.snapshot.sheet)
    affectedNeighbors.value = neighbors.map((neighbor) => ({
      sheetId: neighbor.id,
      code: neighbor.code,
      neighborCodesBefore: [...neighbor.neighborCodes],
    }))
    if (showNotice) {
      ElMessage.success('已按数据库当前资料重新固定快照，请再次核对。')
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '固定资料失败，请稍后重试。'
  } finally {
    fixing.value = false
  }
}

const unsubscribe = onEditAnnounced((message) => {
  if (!snapshot.value) {
    return
  }
  if (
    messageTouchesSheet(
      message,
      sheetId.value,
      affectedNeighbors.value.map((item) => item.sheetId),
    )
  ) {
    stale.value = true
    staleSource.value = message.kind
  }
})

onUnmounted(() => {
  unsubscribe()
})

const staleSourceText: Record<string, string> = {
  sheet: '图幅邻接或编目信息',
  scan: '扫描件',
  placePair: '地名对照',
  history: '沿革清单',
}

async function submitRetire(): Promise<void> {
  const fixedSnapshot = snapshot.value
  if (!fixedSnapshot) {
    return
  }
  if (stale.value) {
    reasonError.value = ''
    ElMessage.warning('资料已被另一页签修改，请先重新核对。')
    return
  }
  if (!reason.value.trim()) {
    reasonError.value = '请填写撤编事由，登记后将随快照保存。'
    return
  }
  reasonError.value = ''
  submitting.value = true
  try {
    const record = await retirementStore.commit(sheetId.value, reason.value.trim(), {
      snapshot: fixedSnapshot,
      fingerprint: fingerprint.value,
      affectedNeighbors: affectedNeighbors.value,
    })
    ElMessage.success('撤编已一次写入，资料快照与邻接图均已处理。')
    void router.replace(`/sheets/${record.sheetId}`)
  } catch (error) {
    if (error instanceof RetirementStaleError) {
      stale.value = true
      staleSource.value = 'fingerprint'
      ElMessage.error('另一页签改动了这份资料，请重新核对后再撤编。')
    } else if (error instanceof RetirementCommitError) {
      failedCheckpointId.value = error.checkpointId
      ElMessage.error('写入失败，已按检查点恢复，不会留下半套撤编结果。')
    } else {
      ElMessage.error(error instanceof Error ? error.message : '撤编失败，请稍后重试。')
    }
  } finally {
    submitting.value = false
  }
}

async function recoverFromCheckpoint(): Promise<void> {
  if (!failedCheckpointId.value) {
    return
  }
  try {
    const result = await retirementStore.recover(failedCheckpointId.value)
    if (result) {
      ElMessage.success('已从检查点恢复到撤编前状态。')
      failedCheckpointId.value = ''
      await fixSnapshot(true)
    } else {
      ElMessage.info('该检查点已处理完毕，无需再次恢复。')
      failedCheckpointId.value = ''
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '检查点恢复失败。')
  }
}

function exportSnapshot(): void {
  if (!snapshot.value) {
    return
  }
  downloadJson(`${snapshot.value.sheet.code}-撤编快照.json`, {
    checkpoint: {
      fingerprint: fingerprint.value,
      fixedAt: snapshot.value.fixedAt,
      reason: reason.value.trim(),
      affectedNeighbors: affectedNeighbors.value,
    },
    ...snapshot.value,
  })
}

function goBack(): void {
  void router.push(`/sheets/${sheetId.value}`)
}

onMounted(() => {
  void fixSnapshot()
})
</script>

<template>
  <section v-if="notFound" class="page">
    <h1>撤编确认</h1>
    <VacantHint title="未找到该图幅" description="图幅可能已被移除，请返回编目台重新选择。" />
  </section>

  <section v-else-if="alreadyRetired && !snapshot" class="page">
    <h1>撤编确认</h1>
    <VacantHint
      title="该图幅已撤编"
      description="可在详情页查看原资料，或从撤编快照撤销。"
      action-text="返回详情页"
      @action="goBack"
    />
  </section>

  <section v-else-if="snapshot" class="page" data-testid="retire-confirm">
    <div class="page-heading">
      <div>
        <span class="page-kicker">SHEET RETIREMENT</span>
        <h1>撤编确认 · {{ snapshot.sheet.code }}</h1>
        <p>
          进入本页时已固定该图幅当前的扫描件、地名对照与沿革清单。
          撤编将一次写入撤编状态、资料快照和受影响邻接图；确认前若另一页签改动了这些资料，请先重新核对。
        </p>
      </div>
      <el-button @click="goBack">返回详情</el-button>
    </div>

    <el-alert
      v-if="stale"
      class="retire-alert"
      type="warning"
      :closable="false"
      show-icon
      data-testid="retire-stale"
    >
      <template #title>
        另一页签已修改
        {{ staleSource === 'fingerprint' ? '该图幅资料' : (staleSourceText[staleSource] ?? '该图幅资料') }}
        ，当前固定快照已过期。
      </template>
      <div class="retire-alert__body">
        为避免撤编与另一页签的整理结果冲突，请先核对改动，再重新固定快照后确认。
        <el-button type="warning" size="small" :loading="fixing" @click="fixSnapshot(true)">
          重新核对并固定
        </el-button>
      </div>
    </el-alert>

    <el-alert
      v-if="failedCheckpointId"
      class="retire-alert"
      type="error"
      :closable="false"
      show-icon
      data-testid="retire-failed"
    >
      <template #title>撤编写入未完成</template>
      <div class="retire-alert__body">
        已自动按检查点恢复；如状态异常，可再次手动从检查点恢复，确认不存在半套撤编结果。
        <el-button type="danger" size="small" plain @click="recoverFromCheckpoint">从检查点恢复</el-button>
      </div>
    </el-alert>

    <p v-if="loadError" class="text-danger">{{ loadError }}</p>

    <div v-loading="fixing">
      <div class="retire-meta">
        <el-tag type="danger" effect="dark">拟撤编</el-tag>
        <span>图幅号：<strong>{{ snapshot.sheet.code }}</strong></span>
        <span>题名：<strong>{{ snapshot.sheet.title }}</strong></span>
        <span>固定时间：{{ fixedAtText }}</span>
        <el-button link type="primary" @click="exportSnapshot">导出固定快照 JSON</el-button>
      </div>

      <div class="retire-grid">
        <div>
          <div class="section-title">
            <div>
              <h2>固定的扫描件（{{ snapshot.scans.length }} 件）</h2>
              <span class="muted">以确认页打开时的条目为准</span>
            </div>
          </div>
          <div class="scan-list">
            <ScanCard v-for="scan in snapshot.scans" :key="scan.id" :scan="scan" />
            <div v-if="snapshot.scans.length === 0" class="empty-inline">固定时该图幅尚无扫描件。</div>
          </div>

          <div class="section-title">
            <div>
              <h2>固定的地名对照（{{ snapshot.placePairs.length }} 条）</h2>
              <span class="muted">含古名、今名、异写与图上方位</span>
            </div>
          </div>
          <div class="place-list">
            <PairRow
              v-for="pair in snapshot.placePairs"
              :key="pair.id"
              :pair="pair"
              :sheet-code="snapshot.sheet.code"
            />
            <div v-if="snapshot.placePairs.length === 0" class="empty-inline">固定时该图幅尚无地名对照。</div>
          </div>

          <div class="section-title">
            <div>
              <h2>固定的沿革清单（{{ sortedHistories.length }} 条）</h2>
              <span class="muted">按年代排列，撤编后仍可在详情中查看</span>
            </div>
          </div>
          <div class="retire-histories">
            <div v-for="history in sortedHistories" :key="history.id" class="retire-history">
              <div class="retire-history__head">
                <strong>{{ history.name }}</strong>
                <el-tag size="small" effect="plain">{{ history.changeType }}</el-tag>
                <span class="muted">{{ history.period }}</span>
              </div>
              <p>{{ history.sourceRef }}</p>
              <p class="muted">{{ history.note }}</p>
            </div>
            <div v-if="sortedHistories.length === 0" class="empty-inline">固定时尚无沿革记录。</div>
          </div>
        </div>

        <aside>
          <form class="side-panel retire-side" @submit.prevent="submitRetire">
            <h2>撤编登记</h2>
            <el-form-item label="撤编事由" required>
              <textarea
                v-model="reason"
                class="native-field"
                rows="4"
                data-testid="retire-reason"
                placeholder="例如：图幅与他馆重复典藏，原件已退回"
              ></textarea>
            </el-form-item>
            <p v-if="reasonError" class="text-danger">{{ reasonError }}</p>

            <div class="retire-neighbors">
              <h3>受影响邻接图（{{ affectedNeighbors.length }} 幅）</h3>
              <p class="muted">下列图幅的邻接图号中将摘除「{{ snapshot.sheet.code }}」，撤销撤编时按原位恢复。</p>
              <ul>
                <li v-for="item in affectedNeighbors" :key="item.sheetId">
                  <strong>{{ item.code }}</strong>
                  <span class="muted">
                    原四至：{{ item.neighborCodesBefore.join('、') || '（无登记）' }}
                  </span>
                </li>
                <li v-if="affectedNeighbors.length === 0" class="muted">没有其他图幅登记本图为邻接。</li>
              </ul>
            </div>

            <el-alert
              title="撤编后该图幅默认不出现在编目台与导出清单，详情仍可查看原资料并可从本快照撤销。"
              type="info"
              :closable="false"
              show-icon
              class="retire-note"
            />

            <div class="retire-actions">
              <el-button :disabled="submitting" @click="goBack">再看看</el-button>
              <el-button
                type="danger"
                native-type="submit"
                :loading="submitting"
                :disabled="stale"
                data-testid="retire-submit"
              >
                确认撤编
              </el-button>
            </div>
            <p v-if="stale" class="text-danger retire-stale-note">请先重新核对并固定快照。</p>
          </form>
        </aside>
      </div>
    </div>
  </section>

  <section v-else class="page">
    <p class="muted">正在固定撤编资料……</p>
  </section>
</template>

<style scoped>
.retire-alert {
  margin-bottom: 16px;
}

.retire-alert__body {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
}

.retire-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
  padding: 14px 18px;
  margin-bottom: 8px;
  background: #f4eadb;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.retire-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(300px, 0.7fr);
  gap: 20px;
}

.retire-side {
  position: sticky;
  top: 96px;
  align-self: start;
}

.retire-neighbors h3 {
  margin-bottom: 6px;
  font-size: 15px;
}

.retire-neighbors ul {
  display: grid;
  gap: 8px;
  padding-left: 18px;
  margin: 10px 0 0;
  font-size: 13px;
}

.retire-neighbors li {
  display: grid;
  gap: 2px;
}

.retire-note {
  margin: 16px 0;
}

.retire-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.retire-stale-note {
  margin: 8px 0 0;
  font-size: 12px;
  text-align: right;
}

.retire-histories {
  display: grid;
  gap: 10px;
}

.retire-history {
  padding: 13px 16px;
  background: #faf5ec;
  border: 1px solid #d4c3ae;
  border-left: 4px solid var(--moss);
  border-radius: 7px;
}

.retire-history__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 5px;
}

.retire-history p {
  margin-bottom: 3px;
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 980px) {
  .retire-grid {
    grid-template-columns: 1fr;
  }

  .retire-side {
    position: static;
  }
}
</style>
