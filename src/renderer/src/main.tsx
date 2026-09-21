import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@renderer/App'
import '@renderer/styles.css'
import '@renderer/appearance.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('未找到 #root 挂载点，无法启动渲染层')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
