# Smart Tab Hygiene

Smart Tab Hygiene 是一个 Chrome / Edge 插件，用来记录标签页停留时间、分类网页，并在你离开电脑或进入低活跃时段后，自动关闭已经过期的标签页。它可以配合 macOS 本地 companion 使用 Apple Core ML 学习你的空闲规律；所有浏览记录和模型数据都保存在本机。

## 核心功能

- 按类别识别网页：NSFW、AI Tools、工作、邮件、新闻、购物、娱乐、资料、金融等。
- 记录每个标签页的停留时间、最后访问时间、交互次数和 favicon。
- 每分钟 checkpoint 当前活跃标签页，减少浏览器 service worker 被挂起导致的停留时间丢失。
- 自动关闭超过类别阈值的旧标签页，并写入 Closed Log。
- 在插件 popup 里可以手动 `Close & Log`，关闭标签页的同时写入日志。
- Closed Log 支持一键 Restore。
- 配合 Swift companion 时，通过 Core ML 学习你什么时候通常不用电脑。
- popup 顶部实时显示本地 ML 状态：`Link: Connected`、训练样本成熟度、模型准确率、最后训练时间、idle confidence 曲线，以及 `NPU / GPU / CPU` 的可用或运行状态。

## 类别默认保留时间

| 类别 | 默认时间 | 说明 |
| --- | ---: | --- |
| NSFW | 12 小时 | 最短保留，过期后优先关闭 |
| Social Media | 3 天 | 社交媒体不适合无限挂着 |
| Entertainment | 5 天 | 视频、音乐、直播类 |
| News | 5 天 | 新闻很快过期 |
| Shopping | 7 天 | 购物车和商品页 |
| Other | 7 天 | 无法分类的默认网页 |
| Reference | 10 天 | 文档、教程、百科 |
| Work & Productivity | 14 天 | GitHub、Notion、Jira、Google Docs 等 |
| Email & Communication | 14 天 | Gmail、Slack、Discord 等 |
| Finance & Banking | 14 天 | 银行、券商、支付、加密货币 |
| AI Tools | 30 天 | ChatGPT、DeepSeek、Claude、Gemini、Hugging Face、Qwen、OpenRouter 等 |

所有阈值都可以在插件 Settings 里调整。

## 安装方式

### 1. 加载浏览器插件

1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 打开右上角 **Developer mode**
3. 点击 **Load unpacked**
4. 选择 `Smart-Tab-Hygiene/extension`
5. 复制插件卡片上显示的 extension ID

### 2. 安装本地 companion

完整的 Apple Core ML 模式需要安装本地 Native Messaging host：

```bash
cd Smart-Tab-Hygiene
chmod +x scripts/install.sh
./scripts/install.sh <extension-id>
```

安装脚本会：

- 编译 Swift companion：`SmartTabHygieneCompanion`
- 安装到 `~/.local/bin/SmartTabHygieneCompanion`
- 为 Chrome / Edge 注册 Native Messaging manifest

如果你已经有预编译的 companion，可以跳过本机 Swift 编译：

```bash
SMART_TAB_HYGIENE_COMPANION_BINARY=/path/to/SmartTabHygieneCompanion ./scripts/install.sh <extension-id>
```

### 3. 重启浏览器

重启后，插件会在需要时自动连接 companion。日志位置：

```text
~/Library/Application Support/Smart Tab Hygiene/companion.log
```

## 为什么不能只安装浏览器插件？

浏览器插件本体可以直接加载，也可以打包给朋友安装；但 Chrome / Edge 的插件包不能自己安装本地可执行文件，也不能自己注册 Native Messaging host。

所以如果要使用 Apple Core ML、本机 NPU/GPU/CPU 计算和本地模型训练，必须额外安装 companion。可以把这个步骤做成 `.pkg` 安装器或签名 macOS app，但无法由浏览器插件静默完成。

如果不安装 companion，插件仍然可以做基础网页分类、停留时间记录、手动 `Close & Log` 和阈值清理，但 ML 空闲时段会退回到保守的 CPU heuristic。

## ML 状态显示

popup 顶部有一个本地智能控制台：

- `Link: Connected`：Native Messaging host 已连接。
- `Training Samples`：当前本地活动样本数和模型成熟度目标。
- `Model Accuracy`：最近一次本地训练/评估得到的准确率；还没有训练时显示 Collecting。
- `Last Local Retrain`：最后一次本地训练时间和 Core ML / CPU fallback 运行方式。
- `Idle Confidence`：当前时刻模型判断“你可能不用电脑”的置信度。
- 置信度曲线：展示未来约 3 小时的 idle confidence 变化。
- 绿色 Low Power 灯：根据最近本地推理活动呼吸显示，用作低功耗视觉化提示，不是直接读取瓦数。
- `ML`：正在使用本地 companion / Core ML 状态。
- `CPU`：没有加载 Core ML 模型时，使用 lookup 或 heuristic fallback。
- `OFF`：Settings 里关闭了 companion。
- `NPU / GPU / CPU`：
  - `AUTO`：Core ML 模型已加载，`computeUnits = all`，系统会自动在可用硬件中选择。
  - `ACTIVE`：当前 fallback 明确运行在 CPU。
  - 灰色：待机或不可用。

注意：Core ML 的公开 API 不会暴露每一次 inference 实际落在 ANE、GPU 还是 CPU。这个插件显示的是实时 health、硬件可用性和请求的 compute units，不伪造系统没有公开的数据。

## 日常使用

- 打开 popup 的 **Active Tabs** 查看当前追踪中的标签页。
- 点击 `Close & Log` 可以从插件内关闭网页，并把它写入 Closed Log。
- 打开 **Closed Log** 可以查看自动或手动关闭的标签页。
- 点击 `Restore` 可以恢复已关闭标签页。
- 打开 **ML Insights** 可以查看 companion 给出的空闲时间预测。
- 打开 Settings 可以修改每个类别的保留天数、白名单和 companion 开关。

## 隐私

数据默认保存在本机：

| 数据 | 位置 |
| --- | --- |
| 浏览器 registry / Closed Log | Chrome / Edge extension local storage |
| 活动训练数据 | `~/Library/Application Support/Smart Tab Hygiene/activity_events.json` |
| Core ML 模型 / lookup | `~/Library/Application Support/Smart Tab Hygiene/TabIdlePredictor.mlmodel`、`idle_lookup.json` |
| companion 日志 | `~/Library/Application Support/Smart Tab Hygiene/companion.log` |

项目没有云端同步，也不会把浏览历史上传到外部服务。

## 卸载

```bash
cd Smart-Tab-Hygiene
./scripts/uninstall.sh
```

然后在 Chrome / Edge 的 extensions 页面移除插件即可。
