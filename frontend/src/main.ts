import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import { ensureCheckpointRecovery } from './utils/recoveryGate'
import './style.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia).use(ElementPlus).use(router)
app.mount('#app')

// 回收上次撤编写入中断遗留的检查点，避免留下半套撤编结果
void ensureCheckpointRecovery().catch((error) => console.error('撤编检查点恢复失败：', error))
