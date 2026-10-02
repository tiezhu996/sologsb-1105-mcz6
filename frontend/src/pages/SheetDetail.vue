<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useSheetStore, type NewScanItem } from '../stores/sheetStore'
import { usePlaceStore } from '../stores/placeStore'
import { useRetirementStore } from '../stores/retirementStore'
import type { ColorMode, ScanQuality } from '../types/scan'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import { usePlaceSearch } from '../hooks/usePlaceSearch'
import { estimateSheetSpan, scaleToText } from '../utils/scale'
import { downloadJson } from '../utils/export'
import PairRow from '../components/common/PairRow.vue'
import ScanCard from '../components/common/ScanCard.vue'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const router = useRouter()
const sheetStore = useSheetStore()
const placeStore = usePlaceStore()
const retirementStore = useRetirementStore()
const searchKeyword = ref('')
const { hits } = usePlaceSearch(searchKeyword)
const showScanForm = ref(false)
const undoing = ref(false)

const sheetId = computed(() => String(route.params.id ?? ''))
const sheet = computed(() => {
  const current = sheetStore.currentSheet
  return current?.id === sheetId.value ? current : undefined
})
const isRetired = computed(() => sheet.value?.status === '已撤编')
const retirement = computed(() => retirementStore.getRetirement(sheetId.value))
const relatedPlaces = computed(() => placeStore.getPairsForSheet(sheetId.value))
const relatedHits = computed(() => hits.value.filter((hit) => hit.pair.sheetId === sheetId.value))
const spanEstimate = computed(() => (sheet.value ? estimateSheetSpan(sheet.value.scale, sheet.value.sheetSizeCm) : undefined))

function createScanForm(): NewScanItem {
  return {
    sheetId: sheetId.value,
    fileName: '',
    resolutionDpi: 600,
    colorMode: '彩色',
    pieces: 1,
    quality: '清晰',
    storageNote: '',
    importedAt: new Date().toISOString(),
    isPrimary: false,
  }
}

const scanForm = reactive<NewScanItem>(createScanForm())
const scanFormError = ref('')

function resetScanForm(): void {
  Object.assign(scanForm, createScanForm())
  scanFormError.value = ''
}

async function submitScan(): Promise<void> {
  if (!scanForm.fileName.trim() || !scanForm.storageNote.trim()) {
    scanFormError.value = '请填写扫描文件名与存放位置。'
    return
  }
  await sheetStore.addScan({
    ...scanForm,
    sheetId: sheetId.value,
    fileName: scanForm.fileName.trim(),
    storageNote: scanForm.storageNote.trim(),
  })
  resetScanForm()
  showScanForm.value = false
}

function exportSheet(): void {
  if (!sheet.value) {
    return
  }
  downloadJson(`${sheet.value.code}-编目.json`, {
    sheet: sheet.value,
    scans: sheetStore.getScansForSheet(sheet.value.id),
    placePairs: relatedPlaces.value,
  })
}

function exportRetirementSnapshot(): void {
  const record = retirement.value
  if (!record) {
    return
  }
  downloadJson(`${record.sheetCode}-撤编快照.json`, record)
}

async function undoRetirement(): Promise<void> {
  if (!retirement.value) {
    return
  }
  undoing.value = true
  try {
    await retirementStore.undo(sheetId.value)
    ElMessage.success('已从快照撤销撤编，图幅恢复为撤编前状态。')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤销撤编失败。')
  } finally {
    undoing.value = false
  }
}

function goRetire(): void {
  void router.push(`/sheets/${sheetId.value}/retire`)
}

async function initialize(): Promise<void> {
  await Promise.all([sheetStore.init(), placeStore.init(), retirementStore.init()])
  await sheetStore.loadSheet(sheetId.value)
}

onMounted(() => {
  void initialize()
})

watch(sheetId, () => {
  resetScanForm()
  void sheetStore.loadSheet(sheetId.value)
})
</script>

<template>
  <section v-if="sheet" class="page" data-testid="detail-sheet">
    <el-alert
      v-if="isRetired && retirement"
      class="retired-banner"
      type="error"
      :closable="false"
      show-icon
      data-testid="retired-banner"
    >
      <template #title>
        本图幅已于 {{ new Date(retirement.finalizedAt ?? retirement.createdAt).toLocaleString('zh-CN') }} 撤编
      </template>
      <div class="retired-banner__body">
        <span>事由：{{ retirement.reason }}</span>
        <span class="muted">
          固定快照：扫描件 {{ retirement.snapshot.scans.length }} 件、
          地名 {{ retirement.snapshot.placePairs.length }} 条、
          沿革 {{ retirement.snapshot.histories.length }} 条；
          受影响邻接图 {{ retirement.affectedNeighbors.length }} 幅。
        </span>
        <div class="retired-banner__actions">
          <el-button size="small" plain @click="exportRetirementSnapshot">导出撤编快照</el-button>
          <el-popconfirm
            title="将按快照恢复图幅原状态与邻接关系，确认撤销撤编？"
            confirm-button-text="确认撤销"
            cancel-button-text="再想想"
            @confirm="undoRetirement"
          >
            <template #reference>
              <el-button size="small" type="danger" :loading="undoing" data-testid="undo-retire">
                从快照撤销撤编
              </el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
    </el-alert>

    <div class="detail-layout">
      <div>
        <header class="detail-hero">
          <span class="detail-hero__code">{{ sheet.code }} · {{ sheet.series }}</span>
          <h1>{{ sheet.title }}</h1>
          <p>{{ sheet.projection }}，图幅尺寸 {{ sheet.sheetSizeCm }}。现登记 {{ relatedPlaces.length }} 条地名对照。</p>
          <div class="detail-hero__tags">
            <el-tag type="warning" effect="dark">{{ sheet.year }} 年</el-tag>
            <el-tag type="info" effect="dark">{{ sheet.scale }}</el-tag>
            <el-tag :type="isRetired ? 'danger' : 'info'" effect="dark">{{ sheet.status }}</el-tag>
            <el-tag v-if="spanEstimate" effect="dark">
              约 {{ spanEstimate.widthKm }} × {{ spanEstimate.heightKm }} 公里
            </el-tag>
          </div>
        </header>

        <template v-if="isRetired">
          <div class="section-title">
            <div>
              <h2>扫描件条目</h2>
              <span class="muted">图幅已撤编，以下为保留的原资料，仅供查看</span>
            </div>
          </div>

          <div class="scan-list">
            <ScanCard v-for="scan in sheetStore.currentScans" :key="scan.id" :scan="scan" />
            <div v-if="sheetStore.currentScans.length === 0" class="empty-inline">该图幅未登记扫描件。</div>
          </div>
        </template>

        <template v-else>
          <div class="section-title">
            <div>
              <h2>扫描件条目</h2>
              <span class="muted">主用件优先作为地名核录与拼合基准</span>
            </div>
            <el-button type="primary" plain @click="showScanForm = true">登记扫描件</el-button>
          </div>

          <form v-if="showScanForm" class="inline-form" @submit.prevent="submitScan">
            <h2>登记扫描件</h2>
            <div class="form-grid">
              <el-form-item label="扫描文件名" required>
                <input v-model="scanForm.fileName" class="native-field" />
              </el-form-item>
              <el-form-item label="分辨率">
                <input v-model.number="scanForm.resolutionDpi" class="native-field" type="number" min="72" max="1200" />
              </el-form-item>
              <el-form-item label="色彩模式">
                <select v-model="scanForm.colorMode" class="native-field">
                  <option v-for="mode in COLOR_MODES" :key="mode" :value="mode">{{ mode }}</option>
                </select>
              </el-form-item>
              <el-form-item label="分块数">
                <input v-model.number="scanForm.pieces" class="native-field" type="number" min="1" />
              </el-form-item>
              <el-form-item label="图像质量">
                <select v-model="scanForm.quality" class="native-field">
                  <option v-for="quality in SCAN_QUALITIES" :key="quality" :value="quality">{{ quality }}</option>
                </select>
              </el-form-item>
              <el-form-item label="存放位置" required>
                <input v-model="scanForm.storageNote" class="native-field" />
              </el-form-item>
              <el-form-item label="设为主用件">
                <el-switch v-model="scanForm.isPrimary" />
              </el-form-item>
              <div class="form-actions">
                <el-button @click="showScanForm = false; resetScanForm()">取消</el-button>
                <el-button type="primary" native-type="submit">保存扫描件</el-button>
              </div>
            </div>
            <p v-if="scanFormError" class="text-danger">{{ scanFormError }}</p>
          </form>

          <div class="scan-list">
            <ScanCard v-for="scan in sheetStore.currentScans" :key="scan.id" :scan="scan" />
            <div v-if="sheetStore.currentScans.length === 0" class="empty-inline">该图幅尚未登记扫描件。</div>
          </div>
          <div v-if="sheetStore.currentScans.length" class="section-title">
            <span class="muted">主用件标记可随时切换，原主用件会自动取消。</span>
            <div>
              <el-button
                v-for="scan in sheetStore.currentScans"
                :key="`primary-${scan.id}`"
                link
                :type="scan.isPrimary ? 'success' : 'primary'"
                :disabled="scan.isPrimary"
                @click="sheetStore.setPrimaryScan(scan.id)"
              >
                {{ scan.isPrimary ? '当前主用件' : `设为主用件：${scan.fileName}` }}
              </el-button>
            </div>
          </div>
        </template>
      </div>

      <aside>
        <section class="side-panel">
          <h2>编目摘要</h2>
          <dl class="fact-list">
            <div><dt>图幅号</dt><dd>{{ sheet.code }}</dd></div>
            <div><dt>所属图组</dt><dd>{{ sheet.series }}</dd></div>
            <div><dt>年代</dt><dd>{{ sheet.year }} 年</dd></div>
            <div><dt>比例尺</dt><dd>{{ sheet.scale }}</dd></div>
            <div><dt>比例尺说明</dt><dd>{{ scaleToText(sheet.scale) }}</dd></div>
            <div><dt>投影</dt><dd>{{ sheet.projection }}</dd></div>
            <div><dt>尺寸</dt><dd>{{ sheet.sheetSizeCm }}</dd></div>
            <div v-if="spanEstimate"><dt>估算跨度</dt><dd>{{ spanEstimate.longitudeSpan }} × {{ spanEstimate.latitudeSpan }}</dd></div>
            <div><dt>扫描件</dt><dd>{{ sheetStore.currentScans.length }} 件</dd></div>
            <div><dt>地名对照</dt><dd>{{ relatedPlaces.length }} 条</dd></div>
          </dl>
          <div class="mt-20 side-actions">
            <router-link :to="`/sheets/${sheet.id}/neighbors`"><el-button>查看邻接与拼合预览</el-button></router-link>
            <el-button v-if="!isRetired" type="primary" plain @click="exportSheet">导出 JSON</el-button>
            <el-button v-else type="info" plain @click="exportRetirementSnapshot">导出撤编快照</el-button>
            <el-button
              v-if="!isRetired"
              type="danger"
              plain
              data-testid="start-retire"
              @click="goRetire"
            >
              办理撤编
            </el-button>
          </div>
        </section>
      </aside>
    </div>

    <section class="section-title">
      <div>
        <h2>图内地名核录</h2>
        <span class="muted">
          {{ isRetired ? '图幅已撤编，以下地名与方位为原资料只读查看。' : '可检索本图幅的古名、今名、异写与图上方位。' }}
        </span>
      </div>
      <el-input v-model="searchKeyword" clearable placeholder="检索本地名" style="width: 260px" />
    </section>

    <div v-if="relatedPlaces.length" class="place-list">
      <PairRow
        v-for="pair in relatedHits.length || !searchKeyword ? relatedPlaces : []"
        :key="pair.id"
        :pair="pair"
        :query="searchKeyword"
        :sheet-code="sheet.code"
      />
      <div v-if="searchKeyword && relatedHits.length === 0" class="empty-inline">本地名未检索到吻合记录。</div>
    </div>
  </section>

  <section v-else class="page">
    <h1>图幅详情</h1>
    <VacantHint title="未找到该图幅" description="图幅可能已被移除，请返回编目台重新选择。" />
  </section>
</template>

<style scoped>
.retired-banner {
  margin-bottom: 18px;
}

.retired-banner__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.retired-banner__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}

.side-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
