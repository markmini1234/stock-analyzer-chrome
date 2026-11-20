# 雪球AI投资伴侣

Chrome/Edge/Firefox 扩展，在雪球股票页左键点击触发 AI 基本面分析。

> 本项目仅用于研究与学习，不构成任何投资建议。

## 功能

- **一键分析**：在雪球股票详情页点击页面，自动识别股票代码、拉取雪球数据，并调用 LLM 生成三维分析报告（价值 + 板块 + 趋势）
- **投研看板**：全量预分析股票池，支持 ROE/估值/股息率排行、行业分布、巴菲特六维评分
- **趋势买点**：基于均线/量能/MACD/RSI 自动识别买点信号，支持 T+5/T+10/T+20 回测
- **AI 对话**：分析浮层内可继续追问
- **记忆系统**：每日分析结果自动沉淀，支持导出/导入
- **模型轮动**：可配置多个 LLM 提供商，失败自动切换

## 安装（开发者模式加载）

```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>

# 切换目标浏览器 manifest
bash scripts/use-manifest.sh chrome   # 或 edge / firefox
```

- **Chrome**：打开 `chrome://extensions/` → 开启“开发者模式” → “加载已解压的扩展程序” → 选择项目目录
- **Edge**：打开 `edge://extensions/` → 开启“开发人员模式” → “加载解压缩的扩展” → 选择项目目录
- **Firefox**：打开 `about:debugging#/runtime/this-firefox` → “临时载入附加组件…” → 选择 `manifest.json`

## 配置

点击扩展图标打开设置页（`options.html`）进行配置：

| 配置项 | 说明 |
|--------|------|
| LLM API Key | OpenAI 兼容接口的 API Key（仅保存在本地浏览器存储中） |
| API Base URL | 默认 `https://api.deepseek.com/v1`，可改为其他兼容接口地址 |
| 模型名称 | 默认 `deepseek-chat`，可按所选服务商填写 |
| 记忆 Token 预算 | 控制每日记忆注入长度，默认 2000 |

说明：
- 扩展通过 OpenAI 兼容的 `POST /chat/completions` 接口调用模型，请确保 Base URL、模型名与 API Key 匹配。
- 雪球相关数据依赖你在浏览器中的雪球登录态；如数据获取异常，请先确认已登录雪球。

## 使用

1. 完成安装与配置
2. 打开任意雪球股票页，如 `https://xueqiu.com/S/SH600519`
3. 在页面点击触发分析，右上角浮层显示分析报告
4. 浮层内支持：重跑 / 强刷 / 导出 TXT / AI 对话
5. 在设置页可查看投研看板、生成周末回测报告等

## 项目结构

```text
.
├── background.js        # 后台服务：数据抓取、LLM 调用、记忆存储、回测引擎等
├── content-script.js    # 注入雪球页面：交互触发、浮层渲染
├── options.html         # 设置页 / 投研看板入口
├── options.js           # 设置页逻辑
├── dashboard.html       # 独立看板页
├── dashboard.js         # 看板渲染逻辑
├── styles.css           # 内容脚本样式
├── manifest.json        # 当前使用的浏览器清单（可由脚本切换）
├── manifests/           # 各浏览器清单模板
│   ├── manifest.chrome.json
│   ├── manifest.edge.json
│   └── manifest.firefox.json
├── scripts/
│   └── use-manifest.sh  # 切换浏览器清单
├── icons/               # 扩展图标
├── docs/                # 文档/示意资源
├── gen_icon.py          # 图标生成脚本
└── LICENSE
```

## 数据与隐私

- **财务/行情数据**：通过雪球相关接口获取，通常需要有效的雪球登录态（Cookie）。
- **本地存储**：分析结果缓存在浏览器本地（如 IndexedDB），配置与密钥存储在浏览器扩展存储（`chrome.storage`）中。
- **第三方请求**：为完成分析，扩展会向你配置的 LLM API 服务发送分析所需的数据/提示词；请自行确认所选服务商的隐私与合规政策。
- **敏感信息**：请勿将真实 API Key、Cookie、Token 或个人导出数据提交到仓库。仓库已提供 `.gitignore` 以排除常见本地/敏感文件。

## 开发说明

- 切换浏览器后请重新加载扩展。
- 修改 `manifest.json` 相关内容时，建议同步更新 `manifests/` 下对应模板，避免下次执行切换脚本时被覆盖。
- 如需自定义 LLM 服务商，优先在设置页中修改 Base URL 与模型名；若服务商域名受限，可能需要同步调整 manifest 的 `host_permissions`。

## 许可证

本项目采用 [MIT License](./LICENSE)。
