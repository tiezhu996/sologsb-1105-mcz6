<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { Sheet } from '../../types/sheet'
import type { FingerprintMismatch } from '../../types/withdrawal'
import { FingerprintError, useWithdrawalStore } from '../../stores/withdrawalStore'
import { db } from '../../utils/db'
import ScanCard from './ScanCard.vue'
import PairRow from './PairRow.vue'

const props = defineProps<{
  modelValue: boolean
  sheet: Sheet
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  committed: []
  restored: []
}>()

const withdrawalStore = useWithdrawalStore()

const reason = ref('')
const formError = ref('')
const pinning = ref(false)
const mismatches = ref<FingerprintMismatch[]>([])
const staleNotice = ref('')
let stopWatching: (() => void) | null = null

const record = computed(() => withdrawalStore.currentRecord)
const snapshot = computed(() => record.value?.snapshot)
const isPinned = computed(() => record.value?.stage === 'pinned')
const needsRecheck = computed(() => mismatches.value.length > 0)

function close(): void {
  emit('update:modelValue', false)
}

/** 打开确认页：固定扫描件、地名对照、沿革清单与受影响邻接图。 */
async function pinCheckpoint(): Promise<void> {
  pinning.value = true
  formError.value = ''
  mismatches.value = []
  staleNotice.value = ''
  try {
    await withdrawalStore.loadForSheet(props.sheet.id)
    // 已撤编图幅不应再进固定流程；其余情况（无记录/曾撤销/残留 pinned）统一重新固定。
    if (record.value?.stage !== 'committed') {
      await withdrawalStore.pin(props.sheet.id, reason.value)
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '固定资料失败，请重试。'
  } finally {
    pinning.value = false
  }
}

/** 固定后若另一页签改动了资料，重新核对指纹；一致才可继续确认。 */
async function recheck(): Promise<void> {
  formError.value = ''
  try {
    const result = await withdrawalStore.reverify()
    mismatches.value = result
    if (result.length === 0) {
      staleNotice.value = ''
      ElMessage.success('资料已重新核对，与固定时一致，可以继续撤编。')
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '重新核对失败。'
  }
}

async function confirmWithdraw(): Promise<void> {
  if (!reason.value.trim()) {
    formError.value = '请填写撤编缘由，便于日后从快照追溯。'
    return
  }
  formError.value = ''
  try {
    // 缘由可能在固定后补填，先更新检查点再走原子提交。
    if (record.value && record.value.reason !== reason.value.trim()) {
      await db.withdrawals.update(record.value.id, { reason: reason.value.trim() })
      record.value.reason = reason.value.trim()
    }
    await withdrawalStore.commit()
    emit('committed')
    close()
  } catch (error) {
    if (error instanceof FingerprintError) {
      mismatches.value = error.mismatches
      staleNotice.value = '固定的资料已被另一个页签改动，请逐项核对后重新固定。'
    } else {
      formError.value = error instanceof Error ? error.message : '撤编写入失败。'
    }
  }
}

/** 提交失败或中途中断后，从检查点恢复，清除半套撤编结果。 */
async function recover(): Promise<void> {
  formError.value = ''
  try {
    const result = await withdrawalStore.recoverFromCheckpoint()
    if (result.recovered) {
      mismatches.value = []
      ElMessage.success(result.detail)
      emit('restored')
      close()
    } else {
      ElMessage.info(result.detail)
    }
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '检查点恢复失败。'
  }
}

async function cancelAndClose(): Promise<void> {
  try {
    await withdrawalStore.cancelPin()
  } finally {
    close()
  }
}

/** 窗口重新获得焦点时（用户可能在另一页签改过资料）自动复核一次。 */
async function handleFocus(): Promise<void> {
  if (!props.modelValue || !isPinned.value) {
    return
  }
  const result = await withdrawalStore.reverify()
  if (result.length) {
    mismatches.value = result
    staleNotice.value = '检测到其他页签改动了本图幅资料，请重新核对。'
  }
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      reason.value = ''
      void pinCheckpoint()
    } else {
      mismatches.value = []
      staleNotice.value = ''
      formError.value = ''
      withdrawalStore.clearCurrent()
    }
  },
)

onMounted(() => {
  stopWatching = withdrawalStore.watchExternalChanges(() => {
    if (!props.modelValue || !isPinned.value) {
      return
    }
    void withdrawalStore.reverify().then((result) => {
      mismatches.value = result
      staleNotice.value = result.length
        ? '另一页签改动了图幅资料，本检查点需重新核对后才能确认撤编。'
        : ''
    })
  })
  window.addEventListener('focus', handleFocus)
})

onBeforeUnmount(() => {
  stopWatching?.()
  window.removeEventListener('focus', handleFocus)
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="办理图幅撤编"
    width="820px"
    :close-on-click-modal="false"
    @update:model-value="(visible: boolean) => (visible ? null : cancelAndClose())"
  >
    <div v-loading="pinning" class="withdraw-dialog">
      <div class="withdraw-dialog__intro">
        <p>
          撤编前先固定 <strong>{{ sheet.code }}</strong> 的当前资料：扫描件、地名对照、沿革清单与受影响邻接图。
          确认时将一次写入撤编状态、资料快照和邻接变更；写入失败可从检查点恢复，不会留下半套结果。
        </p>
      </div>

      <template v-if="snapshot && isPinned">
        <el-alert
          v-if="staleNotice"
          :title="staleNotice"
          type="warning"
          show-icon
          :closable="false"
          class="withdraw-dialog__alert"
        />
        <el-alert
          v-if="needsRecheck"
          title="资料与固定时不一致"
          type="error"
          show-icon
          :closable="false"
          class="withdraw-dialog__alert"
        >
          <ul class="withdraw-dialog__mismatch">
            <li v-for="item in mismatches" :key="item.label">
              <strong>{{ item.label }}</strong>：{{ item.detail }}
            </li>
          </ul>
        </el-alert>
        <el-alert
          v-else-if="record?.lastError"
          :title="`上次写入失败：${record.lastError}`"
          type="error"
          show-icon
          :closable="false"
          class="withdraw-dialog__alert"
        />

        <div class="withdraw-pinned">
          <div class="withdraw-pinned__head">
            <h3>固定资料清单</h3>
            <el-tag type="info" effect="plain">固定于 {{ new Date(snapshot.pinnedAt).toLocaleString('zh-CN') }}</el-tag>
          </div>
          <div class="withdraw-pinned__metrics">
            <div><strong>{{ snapshot.scans.length }}</strong><span>扫描件</span></div>
            <div><strong>{{ snapshot.placePairs.length }}</strong><span>地名对照</span></div>
            <div><strong>{{ snapshot.histories.length }}</strong><span>沿革记录</span></div>
            <div><strong>{{ snapshot.affectedNeighbors.length }}</strong><span>受影响邻接图</span></div>
          </div>

          <div v-if="snapshot.affectedNeighbors.length" class="withdraw-neighbors">
            <h4>受影响邻接图（提交时同步摘除本图幅图号）</h4>
            <ul>
              <li v-for="neighbor in snapshot.affectedNeighbors" :key="neighbor.sheetId">
                <el-tag size="small" :type="neighbor.detached ? 'danger' : 'info'" effect="plain">
                  {{ neighbor.detached ? '摘除指向' : '仅登记在册' }}
                </el-tag>
                {{ neighbor.code }}
              </li>
            </ul>
          </div>

          <el-collapse class="withdraw-collapse">
            <el-collapse-item title="核对扫描件" :name="'scans'">
              <div v-if="snapshot.scans.length" class="withdraw-collapse__body">
                <ScanCard v-for="scan in snapshot.scans" :key="scan.id" :scan="scan" />
              </div>
              <p v-else class="muted">固定时该图幅尚无扫描件。</p>
            </el-collapse-item>
            <el-collapse-item :title="`核对地名对照（${snapshot.placePairs.length}）`" name="places">
              <div v-if="snapshot.placePairs.length" class="withdraw-collapse__body">
                <PairRow
                  v-for="pair in snapshot.placePairs"
                  :key="pair.id"
                  :pair="pair"
                  :sheet-code="sheet.code"
                />
              </div>
              <p v-else class="muted">固定时该图幅尚无地名对照。</p>
            </el-collapse-item>
            <el-collapse-item :title="`核对沿革清单（${snapshot.histories.length}）`" name="histories">
              <ul v-if="snapshot.histories.length" class="withdraw-histories">
                <li v-for="history in snapshot.histories" :key="history.id">
                  <el-tag size="small" effect="plain">{{ history.changeType }}</el-tag>
                  {{ history.period }} · {{ history.name }}
                  <small>出处：{{ history.sourceRef }}</small>
                </li>
              </ul>
              <p v-else class="muted">固定时尚无沿革记录。</p>
            </el-collapse-item>
          </el-collapse>

          <el-form-item label="撤编缘由" required class="withdraw-reason">
            <textarea
              v-model="reason"
              class="native-field"
              rows="2"
              placeholder="例如：图幅与甲-2重复入藏，经审定撤编；原资料留存备查。"
            ></textarea>
          </el-form-item>
        </div>
      </template>

      <p v-if="formError" class="text-danger">{{ formError }}</p>
    </div>

    <template #footer>
      <div class="withdraw-dialog__footer">
        <el-button v-if="record?.lastError" type="warning" plain @click="recover">从检查点恢复</el-button>
        <el-button @click="cancelAndClose">取消</el-button>
        <el-button v-if="needsRecheck" type="primary" plain @click="recheck">重新核对</el-button>
        <el-button
          type="danger"
          :loading="withdrawalStore.busy"
          :disabled="!isPinned || needsRecheck"
          @click="confirmWithdraw"
        >
          确认撤编
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.withdraw-dialog__intro p {
  margin: 0;
  color: #6c594a;
  line-height: 1.75;
}

.withdraw-dialog__alert {
  margin: 14px 0;
}

.withdraw-dialog__mismatch {
  margin: 6px 0 0;
  padding-left: 18px;
}

.withdraw-dialog__mismatch li {
  line-height: 1.8;
}

.withdraw-pinned {
  margin-top: 14px;
}

.withdraw-pinned__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.withdraw-pinned__head h3 {
  margin: 0;
}

.withdraw-pinned__metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0;
}

.withdraw-pinned__metrics div {
  padding: 12px;
  text-align: center;
  background: #f0e7d9;
  border: 1px solid #d7c6b3;
  border-radius: 6px;
}

.withdraw-pinned__metrics strong {
  display: block;
  color: #663023;
  font-size: 22px;
}

.withdraw-pinned__metrics span {
  color: #746457;
  font-size: 12px;
}

.withdraw-neighbors h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.withdraw-neighbors ul {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.withdraw-neighbors li {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.withdraw-collapse {
  margin-top: 12px;
  border-top: 1px solid #ddcfbd;
}

.withdraw-collapse__body {
  display: grid;
  gap: 10px;
  padding-right: 8px;
}

.withdraw-histories {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.withdraw-histories li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.withdraw-histories small {
  width: 100%;
  color: #746457;
}

.withdraw-reason {
  margin-top: 14px;
}

.withdraw-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
