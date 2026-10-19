# opencode-cline-pass

把 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 [opencode](https://opencode.ai)，并完整移植 [`dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass) 的路由、账号池、上游渠道探测与故障转移能力。

插件在 opencode 进程内启动一个**仅监听回环地址的 OpenAI 兼容网关**，再把它注册成 `cline-pass` provider。因此：

- 不需要另起代理进程，也不需要手写 `opencode.json` 的 provider 段；
- 支持流式输出、工具调用、图片输入、reasoning（含 `reasoning_effort` 变体）；
- 支持多账号单账号/轮询、额度耗尽/密钥失效时自动换账号；
- 支持探测模型背后的上游渠道，钉住（pin）或排除（exclude）渠道，并在**首个 token 之前**自动故障转移；
- 提供 8 个 `cline_pass_*` 工具、一个可点击的管理仪表盘、官方额度读取和请求历史。

功能拆解与源码对照见 [`docs/FUNCTIONAL-MODULES.md`](docs/FUNCTIONAL-MODULES.md)。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 模型接入 | 15 个内置订阅模型的目录；可扫描官方清单与 models.dev 采纳新模型 |
| 流式 / 工具 / 图片 / 思考 | OpenAI 兼容 SSE 透传；AI SDK 解析文本、`tool_calls`、`reasoning_content`/`reasoning` |
| 账号池 | 单账号、轮询、启停、增删改、密钥测试；`QUOTA` 冷却 15 分钟，`AUTH` 冷却 30 分钟 |
| 路由 pin | `strict`/`preferred`；按 `cost`/`ttft`/`tps` 排序；排除编译成允许列表 |
| 双拼写 | 同时写 `provider.*`（OpenRouter）与 `providerOptions.gateway.*`（Vercel AI Gateway） |
| 探测 / 校验 / 测试 | 探测 pipeline 与渠道；逐渠道真实验证；干跑 pin 并报告实际服务渠道 |
| 首 token 前故障转移 | 渠道链 + 账号链；一旦交付内容就不再重试 |
| 并发闸门 | 每账号默认 16 条流；FIFO 等待；abort 立即释放 |
| 官方额度 | 5 小时 / 本周 / 本月窗口，逐账号读取 |
| 每日用量 | 按天 × 模型的 token 与成本（仪表盘扩展） |
| 可观测 | 请求历史：账号、渠道、TTFT/总耗时、tokens、错误码、adherence、warnings |
| 管理面 | 8 个工具 + 本地仪表盘 + `/cline-pass` 命令 |
| v1 / v2 | 同一份实现同时提供 v1 `server` 钩子与 v2 `setup` 变换 |

---

## 要求

- opencode **v2.x**（使用 `plugins` 配置与 `setup` 插件格式），或 opencode **v1.19+**（使用 `plugin` 配置与 `server` 钩子）
- Node.js `>= 20.3`（opencode v2 自带 Bun 运行时）
- Cline Pass API Key（`sk_…`）

---

## 安装

### 一键安装（本地 checkout）

在仓库根目录运行：

```bash
./install.sh
# 或
bash examples/install.sh
```

脚本会：

1. 检查 Node.js >= 20.3；
2. `npm install` + `npm run build`；
3. 把仓库软链接到 `~/.config/opencode/plugins/cline-pass`；
4. 首次安装时创建 `~/.config/opencode/cline-pass.json` 和凭据文件（`0600`）；
5. 校验插件入口、JSON 和软链接。

已存在的配置、pin 和凭据会原样保留，所以可以重复执行。密钥获取顺序：

```bash
# 1) 已有凭据：自动复用，不提示
./install.sh

# 2) 环境变量（推荐）
CLINE_PASS_API_KEY=sk_... ./install.sh

# 3) 交互输入（不回显，但 --key 会进 shell 历史）
./install.sh --key sk_...

# 4) 只安装、稍后再配密钥
./install.sh --no-key
```

其他参数：

```bash
./install.sh --no-build   # 只重新链接，要求 dist/ 已存在
./install.sh --force      # 目标目录是真实目录时备份后替换
./install.sh -y           # 非交互；缺少密钥时只警告
```

> 这个脚本注册的是 opencode v2 的目录插件。v1 仍需把仓库路径写进 `plugin` 数组，或使用转发文件（见下方“从本地目录”）。

### 从 npm（发布后）

```bash
opencode plugin add opencode-cline-pass
```

或在配置里显式声明：

```jsonc
// opencode v2
{ "plugins": ["opencode-cline-pass"] }

// opencode v1
{ "plugin": ["opencode-cline-pass"] }
```

### 从本地目录（开发 / 未发布）

一键安装脚本已经覆盖了构建、软链接、配置和凭据：

```bash
./install.sh
```

如果要手动控制：

```bash
npm install
npm run build
ln -s /absolute/path/to/cline-pass-extend ~/.config/opencode/plugins/cline-pass
```

opencode v2 支持把**目录**放进插件搜索路径，或直接写绝对路径：

```jsonc
// 方式 B：写进全局 opencode.json 的 plugins 数组
{
  "plugins": ["/absolute/path/to/cline-pass-extend"]
}
```

opencode v1 可把包目录写进 `plugin` 数组，或在 `~/.config/opencode/plugins/` 放一个转发文件：

```ts
export { default } from "/absolute/path/to/cline-pass-extend/dist/index.js"
```

> 本地目录必须包含 `package.json` 与根级 `server.js`（本仓库已提供）。v2 的目录插件解析 `server`/`index`，v1 解析 `exports["./server"]` 或 `main`。

---

## 配置

### 1. API Key

两种方式，任选其一：

```bash
export CLINE_PASS_API_KEY=sk_xxx
```

或写入凭据库（推荐，权限 `0600`）：

```bash
# 通过仪表盘或工具写入；也可以直接编辑凭据文件
# ~/.config/opencode/cline-pass.credentials.json
{ "CLINE_PASS_API_KEY": "sk_xxx" }
```

凭据解析顺序：**本地凭据文件 → 环境变量**。仪表盘和工具只会回显掩码。

### 2. 插件配置文件

- 全局：`$XDG_CONFIG_HOME/opencode/cline-pass.json`（默认 `~/.config/opencode/cline-pass.json`）
- 项目：`<project>/.opencode/cline-pass.json`（覆盖全局；写入时优先写项目文件）

最小配置：

```json
{
  "baseURL": "https://api.cline.bot/api/v1"
}
```

带多账号与 pin 的完整示例：

```json
{
  "provider": "cline-pass",
  "displayName": "Cline Pass",
  "baseURL": "https://api.cline.bot/api/v1",
  "apiKeyEnv": "CLINE_PASS_API_KEY",
  "accounts": {
    "main": {
      "displayName": "主账号",
      "apiKeyEnv": "CLINE_PASS_MAIN_KEY",
      "enabled": true,
      "baseURL": ""
    },
    "backup": {
      "displayName": "备用",
      "apiKeyEnv": "CLINE_PASS_BACKUP_KEY",
      "enabled": true,
      "baseURL": ""
    }
  },
  "accountMode": "roundrobin",
  "activeAccount": "main",
  "knownModels": [
    "cline-pass/glm-5.3-flash",
    "cline-pass/kimi-k3",
    "cline-pass/deepseek-v4.1-flash",
    "cline-pass/glm-5.2"
  ],
  "hiddenModels": ["cline-pass/kimi-k3"],
  "perModel": {
    "cline-pass/glm-5.2": {
      "upstreams": ["alibaba", "baseten"],
      "exclude": ["deepseek"],
      "pinMode": "preferred",
      "sort": "ttft"
    }
  },
  "models": {
    "cline-pass/glm-5.2": {
      "name": "GLM-5.2 (custom label)",
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "input": ["text", "image"]
    }
  },
  "maxConcurrentRequests": 16,
  "streamIdleTimeoutMs": 300000,
  "defaultContextWindow": 128000,
  "defaultMaxTokens": 64000,
  "exposeTools": true,
  "exposeCatalog": false,
  "skipCatalogScan": false,
  "historyLimit": 100,
  "pinSpelling": "both",
  "serverHost": "127.0.0.1",
  "serverPort": 0,
  "dashboard": true
}
```

### 3. 选择模型

**opencode v2**：

```jsonc
{
  "model": { "providerID": "cline-pass", "model": "glm-5.2" }
}
```

**opencode v1**：

```jsonc
{
  "model": "cline-pass/glm-5.2"
}
```

命令行：

```bash
opencode run --model cline-pass/glm-5.2 "你好"
# v2 推理强度变体（none/minimal/low/medium/high/xhigh/max）
opencode run --model cline-pass/glm-5.2#high "认真想一下"
```

---

## 账号池

```text
cline_pass_accounts action=add    name=main   key=sk_xxx
cline_pass_accounts action=add    name=backup key=sk_yyy
cline_pass_accounts action=mode   mode=roundrobin
cline_pass_accounts action=active active=main
cline_pass_accounts action=test   name=main
cline_pass_accounts action=remove name=backup
```

- `accounts` 为空时，视为一个隐式账号 `default`，使用顶层 `apiKeyEnv`；
- 添加第一个显式账号时会先物化 `default`，避免顶层密钥被孤儿化；
- 账号级拒绝（额度/认证）会触发冷却并换账号；渠道级 429 只换渠道，不让账号下线；
- 全部账号都在冷却时，仍会选择最早到期的账号重试（窗口可能已重置）。

---

## 上游渠道：探测 → 校验 → 钉住

首次使用某个模型时：

```text
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_test     model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"]
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
```

- **探测**：发一条极小请求，识别 `planner`/`direct` 管线，收割可用渠道，并（direct 时）读取 OpenRouter endpoint 详情；
- **校验**：每个渠道发一条真实小请求，只有“响应报告的服务渠道 == 目标渠道”才算 `available`；
- **测试**：按当前 pin 跑完整候选链，返回实际服务渠道与 trace，不持久化；
- **钉住**：`strict` 只允许指定渠道；`preferred` 按顺序尝试并在首个 token 前切换；`sort` 支持 `cost`/`ttft`/`tps`；
- **排除**：编译成允许列表；direct 管线额外写 `ignore`；如果响应报告了被排除的渠道，记录为 `adherence=violated`。

> 200 不代表 pin 生效：路由会静默丢弃不可用的 `only`。请以 `cline_pass_test` 报告的 `actual` 渠道为准。

> 生效时机：账号、pin、并发/超时改动会即时进入下一条请求。opencode v2 下，模型清单、元数据和可见性会尝试通过 `provider.reload()` 即时刷新；如果选择器没有变化，重启 opencode。`exposeTools` 在启动时决定是否注册，改动必须重启；v1 的模型清单/可见性也需要重启。

---

## 工具

`exposeTools` 为真时（默认）注册：

| 工具 | 用途 |
| --- | --- |
| `cline_pass_status` | 路由、账号、掩码密钥、模式、模型/pin 计数、仪表盘地址 |
| `cline_pass_models` | 模型、pipeline、渠道判定、可见性、pin；可刷新目录 |
| `cline_pass_probe` | 探测 pipeline 与渠道 |
| `cline_pass_validate` | 逐渠道真实验证 |
| `cline_pass_test` | 干跑一个 pin 并报告实际渠道 |
| `cline_pass_pin` | 保存 pin（候选顺序、排除、模式、排序） |
| `cline_pass_accounts` | 账号池 list/add/remove/mode/set/test |
| `cline_pass_history` | 内存请求历史 |

设为 `false` 可减少每次请求的工具列表开销；**改动需要重启 opencode**。仪表盘与模型路由不受影响。

---

## 仪表盘

网关根路径提供一个管理页面：

- 账号池：添加/删除/启停/轮换模式、保存与测试密钥（只显示掩码）；
- 官方额度：打开页面自动读取，逐账号的 5 小时/周/月进度与重置倒计时；
- 每日用量：按模型聚合 token 与成本（Cline 的微美元字段已换算为 USD）；
- 模型：搜索、视图筛选、展开/收起、pin 编辑、探测、校验、测试、重置、刷新目录；
- 模型可见性：独立的勾选面板 + 全选/反选，控制哪些模型进入 opencode 选择器（v2 即时刷新，v1 需重启）；
- 最近测试：常驻显示 actual、adherence、目标渠道、attempts trace、reply 和 router plan，不再只是一闪而过的 toast；
- 请求历史：按模型/错误过滤、自动刷新、时间、PIN 判定、账号、TTFT/总耗时、tokens、错误码；
- 设置：`exposeTools` 开关、配置文件路径、复制仪表盘地址/配置路径。

在 opencode TUI 里输入 `/cline-pass` 可以直接打开它（v2 插件命令，不消耗模型 token）。

**如何找到地址**：

1. 调用 `cline_pass_status`，输出里的 `dashboard=…`；
2. 进程运行期间读取 `$XDG_CONFIG_HOME/opencode/cline-pass.runtime.json`：

```json
{
  "url": "http://127.0.0.1:60430",
  "dashboard": "http://127.0.0.1:60430/",
  "provider": "cline-pass",
  "build": "opencode-1",
  "pid": 12345,
  "startedAt": 1792294674000
}
```

> 端口默认随机（`serverPort: 0`），避免多实例冲突。仪表盘只监听回环地址；`/_api` 需要页面内嵌的进程令牌，`/v1` 需要 Bearer 令牌。
>
> 带日期后缀的模型（如 `deepseek-v4.1-flash-1017`）会自动继承基础模型的上下文窗口和模态，不会落回 `defaultContextWindow: 128000`；这能避免长会话被 opencode 过早压缩。如果 Cline 对该快照的实际窗口不同，用 `models.<id>.contextWindow` 显式覆盖。
>
> 多 location / 多 opencode 客户端时，`cline-pass.runtime.json` 只会保留最后启动实例的地址；请以 `/cline-pass` 命令或 `cline_pass_status` 返回的地址为准，它们对应当前 session 的 location。

### 在 opencode 内打开

opencode v2 插件支持直接注册可执行命令。本插件注册了：

```text
/cline-pass
```

在 TUI 输入 `/cline-pass`，会直接打开当前运行的仪表盘，**不消耗模型 token**，也不经过 agent。命令执行的是插件进程里的浏览器打开逻辑，端口由当前 runtime 自动解析。

> 需要 opencode v2（提供 `command.transform`）。插件热更新后，如果命令面板没有立即出现 `/cline-pass`，重启一次 opencode 即可。

如果使用 v1，或所在客户端没有插件命令，仍可用 shell 方式兜底。把 [`examples/cline-pass-open.sh`](examples/cline-pass-open.sh) 复制到 `~/.config/opencode/cline-pass-open`：

```bash
cp examples/cline-pass-open.sh ~/.config/opencode/cline-pass-open
chmod 755 ~/.config/opencode/cline-pass-open
```

然后在 opencode 输入：

```text
!/Users/you/.config/opencode/cline-pass-open
```

也可以直接：

```text
!open "$(jq -r .dashboard ~/.config/opencode/cline-pass.runtime.json)"
```

> 模型行里的渠道标签可以直接点 **钉住 / 排除**，**点击即保存**；pin 顺序的 `↑/↓/×`、`strict/preferred` 与排序下拉也即时保存。只有手动编辑文本框后，才需要点 **保存手动编辑**。`未校验` 只是还没跑过“校验”，不代表渠道不可用。

---

## 配置项

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `provider` | `"cline-pass"` | 注册到 opencode 的 provider id |
| `displayName` | `"Cline Pass"` | UI 显示名 |
| `baseURL` | `https://api.cline.bot/api/v1` | 网关地址 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 默认凭据引用 |
| `accounts` | `{}` | 账号池；空表示一个隐式 `default` |
| `accountMode` | `"single"` | `single` / `roundrobin` |
| `activeAccount` | `""` | single 模式首选账号 |
| `knownModels` | 15 个内置 id | 路由广告的订阅模型 |
| `hiddenModels` | `[]` | 从 picker 隐藏（不删除订阅事实） |
| `models` | `{}` | 单模型覆盖：name/contextWindow/maxTokens/reasoning/input |
| 日期后缀模型 | 自动继承基础模型 | 例如 `deepseek-v4.1-flash-1017` 继承 `deepseek-v4.1-flash` 的 1M 上下文/384k 上限/模态；上游实际不同时用 `models.contextWindow` 覆盖 |
| `perModel` | `{}` | 单模型 pin：upstreams/exclude/pinMode/sort |
| `reasoningModels` | `true` | 未知模型是否默认声明 reasoning |
| `defaultContextWindow` | `128000` | 目录缺失时的上下文窗口 |
| `defaultMaxTokens` | `64000` | 每次请求的输出预算（会被模型上限与半窗口夹住） |
| `streamIdleTimeoutMs` | `300000` | 流空闲超时（按“无字节”计时） |
| `maxConcurrentRequests` | `16` | 每账号并发流；`0` 不限 |
| `exposeTools` | `true` | 是否注册 8 个工具（重启生效） |
| `exposeCatalog` | `false` | 是否把网关 `/models` 并入可选模型 |
| `skipCatalogScan` | `false` | 跳过启动时官方目录扫描（离线环境） |
| `historyLimit` | `100` | 内存历史条数 |
| `pinSpelling` | `"both"` | `both` 双拼写；`detected` 只写探测到的管线 |
| `serverHost` | `"127.0.0.1"` | 本地网关绑定地址 |
| `serverPort` | `0` | 本地网关端口；0 表示随机 |
| `dashboard` | `true` | 是否提供管理页面 |

环境变量：

- `CLINE_PASS_API_KEY` / 任意 `apiKeyEnv` 引用：凭据回退；
- `CLINE_PASS_SKIP_CATALOG=1`：等价于 `skipCatalogScan: true`。

---

## 失败与重试语义

1. **渠道链**：按 `upstreams` 顺序尝试；非 2xx、传输失败、首内容前的错误帧/空流都可切换到下一候选。
2. **账号链**：`AUTH`/`QUOTA` 会把账号加入本轮排除，并从渠道链起点用下一个账号重跑。
3. **首 token 后**：一旦内容到达调用方，后续失败立即上报，不再重试（重试无法撤回已交付的内容）。
4. **冷却**：`QUOTA` 15 分钟、`AUTH` 30 分钟；429 属于渠道级瞬时错误，不冷却账号。
5. **空完成**：没有任何内容的 200 流会以 `EMPTY_RESPONSE` 失败，而不是返回空消息。
6. **并发**：槽按账号隔离，FIFO；abort 会立即离队或释放槽。
7. **超时**：流按空闲计时；abort 优先于超时。

---

## 从 dsh-cline-pass 迁来的差异

| 能力 | dsh-cline-pass | 本实现 |
| --- | --- | --- |
| 接入方式 | `LlmAdapter` + LLM seam | 进程内 OpenAI 兼容网关 + provider 注册 |
| 插件格式 | dsh Cordis 插件 | opencode v1 `server` / v2 `setup`（同一默认导出） |
| 配置 | dsh settings 服务 | JSON 文件（全局 + 项目覆盖） |
| 密钥 | dsh credentials seam | 0600 凭据文件 + 环境变量 |
| 管理面板 | Settings 内嵌 React 卡片 | 本地仪表盘 |
| `exposeTools` 默认 | `false` | `true`（opencode 的主要管理面是工具；可关闭） |
| 图片预算 / 工具组守卫 | 适配器负责 | AI SDK / opencode 负责，网关透传 |
| 模型 id | `cline-pass/…` | 对外 `cline-pass/glm-5.2`，内部 `id=glm-5.2`、`modelID=cline-pass/glm-5.2` |
| 额度 | 面板 action | 仪表盘 + `usage.daily` 扩展 |

其余行为（双拼写、别名、adherence、排除、故障转移、冷却、并发槽、探测/校验、额度识别）按原实现逐条移植，详见功能模块文档第 6 节的不变式清单。

---

## 安全

- 本地网关默认只绑定 `127.0.0.1`，端口随机；
- `/v1` 需要进程内随机 Bearer 令牌（注入到 provider 的 `apiKey`）；
- 仪表盘 `/_api` 需要页面内嵌令牌，并校验 `Origin`；
- 密钥文件与配置文件以 `0600` 写入；
- 仪表盘和工具输出只显示掩码；
- 不要把 `serverHost` 改成 `0.0.0.0` 暴露到不可信网络。

---

## 开发

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test             # vitest：协议 / 配置 / 账号池 / 引擎 / 网关 / 插件 / 仪表盘
npm run build        # 输出 dist/ 与类型声明
```

端到端自测（可选，需要本机 opencode）：

```bash
npm run build
# 将包目录加入 opencode v2 的 plugins，或用软链接放入 ~/.config/opencode/plugins/
# 用任意 OpenAI 兼容 mock 作为 baseURL，然后：
opencode run --standalone --model cline-pass/glm-5.2 "hello"
```

源码结构：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：v1 `server` / v2 `setup`，provider 注入 |
| `src/runtime.ts` | 共享对象图、启动与销毁、运行时指针 |
| `src/v2.ts` | v2 provider/models/tools 变换 |
| `src/server.ts` | 本地 OpenAI 兼容网关、流式故障转移、仪表盘路由 |
| `src/engine.ts` | 探测、校验、测试、账号密钥测试 |
| `src/protocol.ts` | pin 注入、别名、adherence、warnings、错误分类 |
| `src/pool.ts` | 账号池、轮询、冷却 |
| `src/slots.ts` | per-account 并发槽 |
| `src/gateway.ts` | Cline/目录/额度/OpenRouter 传输 |
| `src/stream.ts` | SSE 解析、usage/finish 归一、空闲看门狗 |
| `src/catalog.ts` | 模型目录、元数据解析、opencode 模型配置 |
| `src/config.ts` | JSON 配置、凭据、原子写 |
| `src/store.ts` | 观测状态与历史 |
| `src/tools.ts` | 8 个 `cline_pass_*` 工具 |
| `src/dashboard.ts` | 仪表盘 API 与页面 |
| `src/errors.ts` | 稳定错误码与分类 |
| `src/accounts.ts` | 凭据引用、账号档案、掩码 |

---

## 致谢

- 行为规格与设计来自 MIT 许可的 [`yhshzh/dsh-cline-pass`](https://github.com/yhshzh/dsh-cline-pass)；
- 上游渠道与故障转移研究参考其致谢的 MIT 项目 [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher)；
- 与 Cline 官方无隶属关系；使用前请确认订阅条款。

## License

[MIT](LICENSE)。上游归属与商标说明见 [NOTICE](NOTICE)。
