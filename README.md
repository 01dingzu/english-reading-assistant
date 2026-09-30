# English Reader — 英文辅助阅读器

一个纯前端的英文辅助阅读系统：导入 TXT/EPUB 电子书，点词查义，语境生词本，SM-2 间隔复习。

## 功能

- **阅读即书架的下钻页** — 底部只有三个标签（书架 / 生词本 / 复习）。书架点书直接进正文，左上「← 书架」返回；回书架后顶部会出现「**继续阅读**」卡片（书名 + 第几章 + 已读百分比），一点回到上次读到的那一章
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

朗读不依赖任何第三方服务，原理是「挑出这台设备上最好的语音」，按优先级排：

| 档位 | 音色 | 说明 |
| --- | --- | --- |
| 本地神经模型（推荐） | Kokoro-82M，28 个音色 | 浏览器内推理，**免费、无 Key**，接近真人；首次启用需下载约 88MB，之后朗读不再联网 |
| AI 神经音色 | `Microsoft Aria / Guy / Libby Online (Natural)` | Edge 内置的 Azure 神经语音，免费无需 key，但英文只有 3 个 |
| 云端音色 | `Microsoft * Online`、`Google US English` | 浏览器自带的云端合成 |
| 本机音色 | `Microsoft Zira / Huihui` 等 | 完全离线，机械音 |

- **本地 AI 音色（Kokoro-82M）**：在「语音设置 → 本地 AI 音色」点「下载并启用」即可。模型是 [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)（Apache-2.0，8200 万参数，24kHz），WebGPU 优先、没有则退 WebAssembly。28 个音色分四组：美音 11 女 / 9 男、英音 4 女 / 4 男；官方评级最高的 `af_heart`（A）、`af_bella`（A-）、`af_nicole`（B-）、`bf_emma`（B-）在面板里标 ★。
- 模型**只在你点按钮后下载**，进浏览器缓存（CacheStorage），之后合成完全在本机进行、不再联网，也不用重新下载。跟读时会**边播边合成下一句**，句间基本无空档。
- **Edge 上有 AI 神经音色，Chrome 没有**（Chrome 只给 Google 的机械音）。不想下载模型就用 Edge 打开本站。
- 也可以接自己的 AI 语音：「语音设置 → 自备 AI 语音」填 OpenAI 兼容接口（如 `/v1/audio/speech`），Key 只存本机 IndexedDB，**不会上传到任何地方**——本站没有后端。接口必须是 HTTPS 公网地址（浏览器会拦截网页访问本地/明文接口）。
- **失败会自愈，且不静默**：远程音色首次合成常因冷启动失败，会先重试一次；仍失败就逐级换下一个可用音色并明确提示。本地模型合成失败则本次会话熔断、切回其他音色（不会每句都卡一次），改动设置即可重新启用。设置面板顶部始终显示「当前音色」（降级时标红）。

## 技术栈

纯 HTML / CSS / JavaScript（ES modules），无构建工具。依赖仅 [JSZip](https://stuk.github.io/jszip/)（EPUB 解析，**按需加载**：只在真的要解析 EPUB 时注入，TXT / 内置书 / 财经书库都不付这 96KB）。

## 开发与验证

无构建步骤，但有几个本地检查脚本（都需要 `python -m http.server 8891 --bind 127.0.0.1` 常驻在项目根目录）：

```bash
node static-check.mjs js/*.js verify-*.mjs   # 静态引用检查：调用的函数是否都有定义
node test.mjs                                # 单元测试（词典 / 断句 / 离线直译 / SM-2）
node verify-shelf.mjs                        # 浏览器端回归：书架与阅读导航
node verify-features.mjs                     # 段落翻译 + 词句翻译 + 书签
node verify-guide.mjs                        # 新手指引
node verify-finance.mjs                      # 财经书库导入到阅读
node verify-flashcards.mjs                   # 闪卡交互
node verify-tts.mjs [浏览器exe]              # 朗读链路（用 Edge 跑断言更强：有神经音色）
node verify-kokoro.mjs                       # 本地 AI 音色（注入假模型，不真下 88MB）
```

`verify-*.mjs` 共用 `verify-lib.mjs`：起浏览器、收集 console/pageerror、断言计数、关掉新手引导遮罩、收尾打印都在那里。改 Chrome 路径、端口或视口只动一个文件。

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
