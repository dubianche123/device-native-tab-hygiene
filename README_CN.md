<div align="right">
  <sub>
    <a href="README.md">English</a> |
    <strong>中文</strong>
  </sub>
</div>

# Neural-Janitor：端侧加速的标签页自动化管理

## 一个本地化、NPU 驱动的浏览器自动化引擎

**版本**：1.0 MVP  
**作者**：Leo  
**日期**：2026 年 5 月  

Neural-Janitor 是一个智能浏览器扩展，旨在通过预测你的真实闲置时间来清理你的数字工作区。它利用 Apple 本地的机器学习技术栈（Core ML）直接在设备端学习你的使用习惯，在保持浏览器轻快运行的同时，绝不泄露你的隐私。

它没有采用死板的硬编码定时器来清理旧标签页，而是基于一个核心理念：

**浏览器自动化应该安静、安全且几乎零功耗地适应用户的日常习惯。**

为了实现这一点，Neural-Janitor 会在本地记录轻量级的标签页活动。macOS Swift 伴随程序将这些活动转化为训练数据，随后 Core ML 会在 Apple 神经网络引擎（NPU）上进行持续预测，以找到清理工作区的最佳时机。

## 运行时数据流

```text
┌─────────────────────────────────────────────────────────┐
│  Chrome / Edge Extension (Manifest V3)                  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐ │
│  │ Tab      │  │ Category │  │ Stale Tab Checker     │ │
│  │ Tracker  │→ │ Engine   │→ │ (alarm every 30 min)  │ │
│  └──────────┘  └──────────┘  └───────────────────────┘ │
│       ↕                                    ↓            │
│  ┌──────────────────────┐    ┌───────────────────────┐ │
│  │ Native Messaging     │    │ Closed Tab Log        │ │
│  │ Client               │    │ (by category, local)  │ │
│  └──────────┬───────────┘    └───────────────────────┘ │
└─────────────┼───────────────────────────────────────────┘
              │ Native Messaging (stdio)
              ↓
┌─────────────────────────────────────────────────────────┐
│  macOS Companion App (Swift)                            │
│                                                         │
│  ┌──────────────────────┐  ┌─────────────────────────┐ │
│  │ Activity Collector   │→ │ Core ML Predictor       │ │
│  │ (timestamps, state)  │  │ (runs on ANE / NPU)     │ │
│  └──────────────────────┘  └─────────────────────────┘ │
│                                    ↓                    │
│                           Idle window predictions       │
│                           sent back to extension        │
└─────────────────────────────────────────────────────────┘
```

这张架构图把两个执行环境明确分开：
- **浏览器上下文**：Manifest V3 扩展，负责追踪标签页焦点、交互和内容分类。
- **原生上下文**：Swift 伴随程序（Companion App），处理模型训练、预测以及本地 NLP 分类。

## 为什么这样设计

许多现代浏览器标签页管理工具依赖简单的硬编码定时器（例如，“3天后关闭标签页”）。这很可预测，但也存在根本缺陷：用户可能正在积极使用电脑，只是没有查看那个特定的标签页；或者他们可能正在休两周的假。

Neural-Janitor 让模型承担了更聚焦的任务。它构建了一个 `MLBoostedTreeClassifier` 来预测用户何时真正离开 Mac。它只在预测的长期闲置窗口期间清理标签页，确保你回来时不会发现工作区突然消失。

| 痛点 | 传统的标签页清理工具 | Neural-Janitor 架构 |
|:--|:--|:--|
| **何时关闭？** | 硬编码的静态定时器（如 7 天）。 | 由 Core ML 闲置预测控制的动态定时器。 |
| **内容分类** | 简单的 URL 域名匹配。 | 基于 Apple `NaturalLanguage` 框架的设备端 NLP 分词。 |
| **资源消耗** | JavaScript 在后台持续轮询。 | 事件驱动的后台 Worker + NPU 加速推理。 |
| **隐私安全** | 通常需要将数据同步到云端。 | 100% 本地运行。零遥测数据离开设备。 |

## 分类超时规则

标签页会根据其分类被分配一个闲置阈值。伴随程序使用本地关键词启发式算法和自然语言分词来进行分类。

| 分类 | 最大闲置时间 | 理由 |
|----------|--------------|-----------|
| **NSFW** | **12 小时** | 随看随走，尽快关闭。不等闲置窗口。 |
| Social Media | 3 天 | 错失恐惧症（FOMO）消退得很快。 |
| Entertainment | 5 天 | 周二打开的 Netflix 标签页？关掉吧。 |
| News | 5 天 | 过时的新闻就不再是新闻了。 |
| Shopping | 7 天 | 购物车会被放弃，标签页也一样。 |
| Other | 7 天 | 未分类 URL 的默认值。 |
| Reference | 10 天 | Stack Overflow 的答案经得起时间考验。 |
| Work & Productivity | 14 天 | PR 和 Jira 任务需要时间处理。 |
| Email & Communication | 14 天 | Slack/Gmail 可能需要保持会话连续性。 |
| **Finance & Banking** | **30 天** | 银行会话很宝贵，但也不是永久的。 |
| **AI Tools** | **30 天** | 持续的研究和对话窗口通常是被刻意保留的。 |

## 系统架构

系统被拆分为两个可部署的组件：

1. **Manifest V3 Extension**：处理浏览器标签页，注入 content scripts 追踪交互，管理本地关闭标签页注册表，并通过 Native Messaging 与伴随程序通信。
2. **Swift Companion App**：一个不可见的 macOS 守护进程，负责聚合行为数据，训练本地 ML 模型，并提供闲置预测和页面分类。

### 1. 标签页交互追踪器 (Tab Interaction Tracker)
追踪 `openedAt`（打开时间）、`lastVisited`（最后访问时间）、`dwellMs`（累计前台停留时间）和 `interactions`（交互次数）。当标签页被关闭时，这些指标会被保存在与 `chrome.sessions` 绑定的日志中，以便将其完全恢复到原样。

### 2. 本地页面分类器 (Local Page Classifier)
当扩展程序无法自信地对 URL 进行分类时，它会询问伴随程序。伴随程序使用 Apple `NaturalLanguage` 框架对网页标题、描述和内容进行分词，并对照加权分类法进行打分。

### 3. Core ML 预测器 (Core ML Predictor)
伴随程序从历史活动中构建一个包含 9 个特征的 `TrainingSample`（星期几、时间、平均停留时间、标签页数量、周末标志等）。它持续训练一个 `MLBoostedTreeClassifier`。通过编译为 Core ML，macOS 会自动将推理工作负载调度到 Apple Silicon 上的神经网络引擎 (ANE)，功耗可忽略不计（毫瓦级）。

## 安全与隐私

- **无云端分析**：所有活动日志、ML 模型和标签页注册表都完全保留在 `~/Library/Application Support/Mimo/` 和扩展程序的本地存储中。
- **零追踪注入**：不注入远程脚本或追踪像素。
- **纯本地模型**：Core ML 模型完全在你的机器上使用你的数据进行训练。

## 可迁移的模式

这个项目真正可迁移的不仅仅是标签页清理，而是：
**浏览器遥测数据 + 本地 Swift 伴随程序 + NPU 加速的 ML 推理**

它可以迁移到：
- **本地广告拦截器**：根据你的浏览习惯训练模型，抢先拦截动态追踪模式。
- **专注代理**：在预测的深度工作时间段自动屏蔽干扰网站。
- **内容总结器**：将繁重的 DOM 解析和总结工作卸载给原生 Swift，而不是让 V8 引擎持续高负载。

## 安装指南

### 1. 构建伴随程序
```bash
cd Mimo
chmod +x scripts/install.sh
./scripts/install.sh
```

### 2. 加载扩展程序
在 Chrome/Edge 中将 `Mimo/extension` 文件夹作为未打包的扩展程序加载。复制 Extension ID。

### 3. 链接扩展程序
```bash
./scripts/install.sh 你的_EXTENSION_ID
```
重启浏览器。伴随程序将自动启动。

## 结论

Neural-Janitor 测试了一个架构判断：我们不需要为每个智能功能都依赖云端 LLM。通过将 Manifest V3 的事件驱动架构与 macOS 的原生 ML 能力相结合，我们可以实现一种私密、高性能且深度集成到操作系统的上下文感知自动化管理。

<p align="center"><sub>Neural-Janitor: Edge-Accelerated Tab Hygiene</sub></p>
