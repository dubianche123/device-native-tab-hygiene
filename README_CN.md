<div align="right">
  <sub>
    <a href="README.md">English</a> |
    <strong>中文</strong>
  </sub>
</div>

# Neural-Janitor

### 基于 Apple Core ML 的端侧加速标签页自动化管理

Neural-Janitor 是一款智能 Chrome/Edge 扩展，它能学会何时关闭你的标签页。与静态定时器不同，它利用本地 Swift 伴随程序和 Core ML 预测你的闲置状态，并根据你的实际使用习惯学习保留时长——这一切完全在设备端完成。

---

## ⚡ Chronos 引擎：工作原理

Neural-Janitor 通过结合三个本地信号，超越了简单的定时器逻辑：

1.  **手动学习**：基于你真实的手动关闭行为，学习每个类别（AI、工作、金融等）的首选保留时间。
2.  **情境倍率**：Core ML 模型预测机器的闲置窗口。当你可能不在电脑前时，它会促使清理逻辑变得更加积极。
3.  **标签重要度**：根据前台停留时间、交互次数和类别优先级为标签页打分（AI 工具保留更久，社交媒体消失更快）。

<details>
<summary><b>查看系统架构 (C4 图表)</b></summary>

\`\`\`mermaid
flowchart TB
  subgraph browser["浏览器扩展 (Manifest V3)"]
    direction LR
    popup["🖥️ Popup UI"]
    tracker["📍 标签追踪"]
    category["🏷️ 类别引擎"]
    hygiene["🧹 清理调度"]
  end

  subgraph native["macOS Swift 伴随程序"]
    direction LR
    collector["📥 活动采集"]
    classifier["🔤 页面分类"]
    predictor["🧠 Chronos 引擎"]
  end

  coreml[["⚡ Apple Core ML 运行时"]]

  tracker --> category --> hygiene
  tracker --> collector
  category --> classifier
  collector --> predictor
  classifier --> predictor
  predictor <--> coreml
  predictor --> popup
\`\`\`
</details>

---

## ✨ 核心功能

- **个性化学习**：自动调整每个类别和域名的关闭阈值（例如：你特定的券商网站 vs 普通金融类）。
- **AI 驱动清理**：一键“AI Clean”回收内存并降低标签页数量，同时保护重要的工作和 AI 会话。
- **智能策略**：
    - **白名单**：永不关闭特定域名。
    - **定时黑名单**：为干扰网站（如社交媒体）设置固定的时/分限制，且不计入学习。
    - **节假日感知**：支持日本/中国日历，自动调整周末和节假日的清理行为。
- **隐私至上**：100% 本地运行。无云端遥测，无远程脚本，无数据泄露。
- **遥测界面**：实时 MEM/CPU 监控和透明的“关闭学习”统计数据。

---

## 🛠️ 安装指南

1.  **加载扩展**：
    - 打开 `chrome://extensions`，启用**开发者模式**。
    - 点击 **Load unpacked** 并选择 `extension/` 文件夹。
    - 复制 **Extension ID**。

2.  **链接伴随程序**：
    \`\`\`bash
    chmod +x scripts/install.sh
    ./scripts/install.sh 你的_EXTENSION_ID
    \`\`\`

3.  **重新加载**：在浏览器中重新加载扩展，伴随程序将自动启动。

---

## 📂 数据与迁移

学习模型和日志保存在：
\`~/Library/Application Support/Neural-Janitor/\`

**导出/导入模型：**
\`\`\`bash
# 仅导出模型
./scripts/export_model_bundle.sh --output ~/Desktop

# 在另一台 Mac 导入
./scripts/import_model_bundle.sh path/to/bundle.tar.gz
\`\`\`

---

## 🏗️ 开发相关

验证 JS 语法并构建：
\`\`\`bash
# 检查扩展逻辑
node --check extension/js/background.js
# 构建 Swift 伴随程序
swift build -c release --package-path companion/NeuralJanitorCompanion
\`\`\`

<p align="center"><sub>Neural-Janitor — Chronos 引擎 — 为更整洁的 Web 提供本地智能。</sub></p>
