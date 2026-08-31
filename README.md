# English Reader — 英文辅助阅读器

一个纯前端的英文辅助阅读系统：导入 TXT/EPUB 电子书，点词查义，语境生词本，SM-2 间隔复习。

## 功能

- **书籍导入** — 支持 TXT / EPUB，自动统计生词率并标注难度（舒适 / 适中 / 挑战）
- **财经英语书库** — 书架内置 3 本公版财经经典，一键导入：理财入门《The Richest Man in Babylon》、华尔街经典《Reminiscences of a Stock Operator》、经济学奠基《The Wealth of Nations》选读
- **点词查义** — 3.7 万词离线词典（音标、中文释义、考试标签、词频），词形还原三层兜底（原词 → 变形表 → 后缀规则）
- **语境生词本** — 查词时自动保存原文句子，生词不脱离语境
- **间隔复习** — SM-2 算法调度，语境填空 + 听音拼写两种题型
- **闪卡刷词** — 生词本内直接翻卡：正面单词 → 翻面看释义/语境 → 三键自评（认识/模糊/不认识），自评结果同步到 SM-2
- **朗读** — 单词 / 例句 TTS 朗读（Web Speech API）
- **离线优先** — 词典本地加载，无网络也能读和查

数据全部存在浏览器 IndexedDB，无账号、无后端、无追踪。

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
