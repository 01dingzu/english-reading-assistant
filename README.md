# English Reader — 英文辅助阅读器

一个纯前端的英文辅助阅读系统：导入 TXT/EPUB 电子书，点词查义，语境生词本，SM-2 间隔复习。

## 功能

- **书籍导入** — 支持 TXT / EPUB，自动统计生词率并标注难度（舒适 / 适中 / 挑战）
- **财经英语书库** — 书架内置 5 本公版财经经典，一键导入：理财入门《The Richest Man in Babylon》、华尔街经典《Reminiscences of a Stock Operator》、经济学奠基《The Wealth of Nations》选读、投资实操《How to Invest Money》、股市运作《The Stock Exchange from Within》
- **点词查义** — 3.7 万词离线词典（音标、中文释义、考试标签、词频），词形还原三层兜底（原词 → 变形表 → 后缀规则）
- **语境生词本** — 查词时自动保存原文句子，生词不脱离语境
- **间隔复习** — SM-2 算法调度，语境填空 + 听音拼写两种题型
- **闪卡刷词** — 生词本内直接翻卡：正面单词 → 翻面看释义/语境 → 三键自评（认识/模糊/不认识），自评结果同步到 SM-2
- **句子翻译** — 每段末尾「译」一键逐句中译：在线翻译（MyMemory 免费接口）优先，断网自动回退离线直译（词典词对词），结果本地缓存；点词释义面板里的语境句也能直接「译句」
- **朗读（AI 音色）** — 一键逐句朗读整章，读到哪高亮到哪、自动滚动；底部控制条可暂停 / 上下句 / 调语速 / 换音色。见下方「朗读引擎」
- **书签** — 阅读中随时 🔖 收藏当前位置，📑 列表一键跳回，可删除；书签随备份导出/导入迁移
- **离线优先** — 词典本地加载，无网络也能读和查（翻译回退离线直译）

数据全部存在浏览器 IndexedDB，无账号、无后端、无追踪。

## 朗读引擎

朗读不依赖任何第三方服务，原理是「挑出这台设备上最好的语音」：

| 档位 | 音色示例 | 说明 |
| --- | --- | --- |
| AI 神经音色 | `Microsoft Aria / Guy / Ana Online (Natural)` | Edge 内置的 Azure 神经语音，**免费、无需 key**，音质接近真人 |
| 云端音色 | `Microsoft * Online`、`Google US English` | 浏览器自带的云端合成 |
| 本机音色 | `Microsoft Huihui` 等 | 完全离线，机械音 |

- **Edge 上有 AI 神经音色，Chrome 没有**（Chrome 只给 Google 的机械音）。想要最好的音质就用 Edge 打开本站。
- Chrome 用户可以在「语音设置 → 自备 AI 语音」里填自己的 OpenAI 兼容语音接口（如 `/v1/audio/speech`），Key 只存本机 IndexedDB，**不会上传到任何地方**——本站没有后端。
- **音色失败会自愈**：远程音色的首次合成常因冷启动失败，程序会先重试一次；仍失败就逐级换用下一个可用音色，并明确提示换了哪个，不会静默没声。设置面板顶部始终显示「当前音色」（降级时标红）。

## 技术栈

纯 HTML / CSS / JavaScript（ES modules），无构建工具。依赖仅 [JSZip](https://stuk.github.io/jszip/)（EPUB 解析）。

## 数据来源

词典数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（开源词典，保留高频词与考试词汇裁剪）。内置示例书为伊索寓言（公版）。

## 本地运行

```bash
cd reader
python -m http.server 8734
# 打开 http://localhost:8734
```

任何静态服务器均可。

## 词典重建（可选）

`process_dict.py` 从完整 ECDICT CSV 裁剪生成 `data/dict.json`：

```bash
# 下载完整版 CSV 到 data/ecdict-full.csv（约 66MB，不入库）
python process_dict.py
```
