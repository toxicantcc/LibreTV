# LibreTV 改造方案：前端（Vue）与 Node 服务端（详细版）

> 本文描述将「浏览器内拦截 `fetch`、在 `js/api.js` 里假扮 `/api`」拆成「独立 Vue 前端 + 真实 Node HTTP 服务」时的职责划分、接口约定、目录建议、部署与迁移顺序，便于后续做安卓 App（uni-app）或纯 H5。  
> 实现时请仍以仓库内 `js/api.js`、`js/config.js`、`server.mjs`、`js/proxy-auth.js` 为准，本文在结构层面归纳，细节以代码为准。

---

## 一、为什么要拆

### 1.1 当前行为（简图）

```
浏览器加载 index.html / player.html
    → 加载 js/config.js（PROXY_URL、API_SITES 等）
    → js/api.js 替换 window.fetch：凡 pathname 以 /api/ 开头则在内存里执行 handleApiRequest
    → 真实出站请求走 /proxy/<encode(上游URL)>?auth=...&t=...
```

- **搜索、详情等业务逻辑全部跑在用户浏览器里**，只是 URL 看起来像 `/api/search`。
- **安卓 App、Postman、uni-app 的 `uni.request`** 不会执行这段 `fetch` 劫持，因此必须提供 **真正的 HTTP 路由**。

### 1.2 目标行为（简图）

```
Vue / uni-app（任意客户端）
    → HTTPS GET https://你的域名/api/search?wd=...
    → Node（Express）路由处理：读参数、拼上游 URL、服务端请求代理或直连、返回 JSON
    → 客户端解析 JSON 渲染列表 / 播放页
```

- **同一套 Node 进程** 可同时：托管 Vue `dist`、提供 `/api/*`、提供现有 **`/proxy/:encodedUrl`**（见 `server.mjs`）。

---

## 二、与现有代码的对应关系

| 能力 | 当前位置 | 改造后归属 |
|------|-----------|------------|
| 站点配置（源列表、路径模板等） | `js/config.js` | 可 **复制为 Node 侧配置模块** + 前端仅保留展示用/用户可选源；或 Node 全量持有，前端只收「选项 ID」 |
| 搜索 / 详情主流程 | `js/api.js` 中 `handleApiRequest` 及若干 `handle*Detail` | **Node 路由**（或抽成 `server/lib/api-handlers.mjs` 被 Express 调用） |
| 代理出站（绕 CORS、统一 UA） | 浏览器请求 `PROXY_URL` → `server.mjs` 的 `GET /proxy/:encodedUrl` | **保留**；Node 处理 `/api` 时可在 **服务端内部** 请求 `http://127.0.0.1:PORT/proxy/...` 或直接 axios 上游（二选一，见下文） |
| 代理鉴权 query（`auth`、`t`） | `js/proxy-auth.js` + 页面注入 `__ENV__.PASSWORD` | 服务端 `/api` **无浏览器 localStorage**：应用 `PASSWORD` 环境变量算 SHA256，在服务端拼代理 URL；前端若仍调 `/proxy`，需继续带鉴权参数或与后端约定 **仅服务端代拉流** |

---

## 三、方案 A：前端（Vue / uni-app）

### 3.1 技术选型（细化）

| 层级 | 建议 | 说明 |
|------|------|------|
| 框架 | Vue 3 + `<script setup>` + TypeScript | 与 uni-app 3 默认栈一致，类型有利于约定接口返回结构 |
| 构建 | Vite | `import.meta.env.VITE_API_BASE` 注入基地址 |
| 路由 | Vue Router | 路径示例见下节 |
| 请求 | axios 或 `ofetch` | 统一实例：baseURL、超时、错误 JSON 解析 |
| 状态 | Pinia（可选） | 搜索条件、当前源、播放进度、用户信息等 |
| 仅 H5 | 可继续用 hls.js + 自定义播放器组件 | 与现有 `player.html` 能力对齐 |
| 安卓（uni-app） | `manifest.json` 配网络与域名白名单；`video` 组件与各厂商差异需真机测 | 播放 URL 若为 HTTP 明文，需在 Android 网络安全配置里放行（仅建议内网调试） |

### 3.2 建议页面与路由（示例）

| 路由 path | 页面职责 | 对应旧站参考 |
|-----------|-----------|--------------|
| `/` | 搜索框、源选择、历史入口 | `index.html` + `js/app.js` / `js/search.js` |
| `/search` | 结果列表（支持 query：`wd`、`source`） | 搜索结果区 |
| `/detail/:id` | 剧集信息、选集、跳转播放 | 详情逻辑分散在 `app.js`、`player.js` |
| `/play` | 播放器全屏或内嵌（query：`id`、`source`、集数索引等） | `player.html` + `js/player.js` |

路由名可按你产品习惯调整，关键是 **状态与参数** 与后端 query 对齐。

### 3.3 建议目录结构（单仓「子目录前端」示例）

```
web/                          # 新建 Vue 工程根目录（名称自定）
├── .env.development          # VITE_API_BASE=http://localhost:8080
├── .env.production           # VITE_API_BASE=https://api.example.com
├── src/
│   ├── api/
│   │   ├── client.ts         # axios 实例：baseURL、拦截器
│   │   ├── search.ts         # searchDetail(...)
│   │   └── detail.ts
│   ├── views/
│   ├── components/
│   ├── router/
│   ├── stores/               # Pinia（可选）
│   └── types/
│       └── api.d.ts          # 与后端约定的 JSON 结构
├── vite.config.ts
└── package.json
```

### 3.4 HTTP 封装要点

1. **baseURL**：一律 `import.meta.env.VITE_API_BASE`，禁止在业务组件里写死域名。  
2. **路径**：与现网一致使用 **`/api/search`、`/api/detail`**（迁移后由 Node 实现），减少前端改动面。  
3. **错误**：后端已习惯返回 `code: 400/500` 与 `msg`（见 `handleApiRequest` 的 catch），前端统一解析：非 200 或 `code !== 200` 时 toast 或错误页。  
4. **超时**：与现逻辑类似建议 **10s** 量级，避免弱网挂死。  
5. **鉴权**（若你保留「用户输入站点密码」）：  
   - 方案 1：登录后后端发 **短期 Token**，后续 `Authorization: Bearer ...`；  
   - 方案 2：继续用 **密码哈希** 参与签名或 query（需与 Node 扩展一致）；  
   - 不要在 Git 里提交真实密码；生产用 HTTPS。

### 3.5 与现有前端文件的迁移对照（便于分任务）

| 旧文件（仓库根下） | 新前端大致去向 |
|-------------------|----------------|
| `js/config.js` | 仅保留「用户可改的配置」到前端；**源 URL、API 路径模板** 建议逐步迁到 Node，避免把上游地址完全暴露在打包产物（可选安全加固） |
| `js/api.js` | **删除「fetch 劫持」概念**；逻辑由 Node 承接；前端只保留 `api/search.ts` 等薄封装 |
| `js/search.js`、`js/app.js` | 拆成 Vue 页面 + composable（如 `useSearch`） |
| `js/player.js` | 拆成 `PlayView.vue` + 播放器 composable；解析 `episodes` 与当前集 |
| `js/ui.js` | 拆成通用组件（对话框、Loading、Toast） |
| `js/douban.js` 等 | 按功能迁入 `src/api` 或组件，若仍调第三方需注意 CORS（可改由 Node 转发） |

### 3.6 uni-app（安卓）额外注意

- **条件编译**：`#ifdef H5` 与 `APP-PLUS` 下播放器、下载、后台播放能力不同。  
- **请求**：`uni.request` 同样使用 **完整 baseURL + `/api/...`**。  
- **cookie**：与浏览器行为不完全一致；会话态优先用 **Token + 本地存储**。  
- **版本**：关注 Vue 3 + Vite 版 uni-app 与官方对 `video` 源格式的说明。

### 3.7 前端验收清单（建议）

- [ ] 仅配置 `VITE_API_BASE` 即可在开发环境跑通搜索 → 详情 → 播放。  
- [ ] 无任何 `window.fetch` 劫持或「假 `/api`」依赖。  
- [ ] 生产构建产物可在 **单独静态托管** 下工作（即与 API 同域或 CORS 已配置）。  
- [ ] 弱网、超时、空列表有明确 UI 提示。

---

## 四、方案 B：Node 服务端

### 4.1 现状（`server.mjs`）已具备能力

- `cors`：`CORS_ORIGIN`（默认 `*`）。  
- 安全响应头：`X-Content-Type-Options`、`X-Frame-Options` 等。  
- **页面**：`/`、`/index.html`、`/player.html`、`/s=:keyword` 读盘渲染并替换 `{{PASSWORD}}`。  
- **代理**：`GET /proxy/:encodedUrl`，校验 `auth`（SHA256 与服务端 `PASSWORD` 一致）、`t`（约 10 分钟），再 `axios` 流式转发。  
- **静态**：`express.static` 整个项目根目录。

### 4.2 需要在 Node 中新增的核心：`/api/*`

当前浏览器侧入口为 `js/api.js` 中对以下路径的分发（实现前请全文阅读该文件及其中调用的函数）：

| 方法 | 路径 | 作用概述 |
|------|------|----------|
| GET | `/api/search` | 按 `wd`、数据源 `source`、可选 `customApi` / `customDetail` 等拉取列表；内含多源聚合、自定义源等分支 |
| GET | `/api/detail` | 按 `id`、`source`、可选 `customApi`、`customDetail`、`useDetail` 等取详情与 `episodes`；内含「特殊源 HTML 解析」「自定义源」等分支 |

其它路径在 `handleApiRequest` 末尾会 `throw new Error('未知的API路径')`，迁移时一并覆盖即可。

### 4.3 建议的 Query 参数约定（与现前端对齐，迁移时核对）

**`/api/search`（常见）**

| 参数 | 含义 |
|------|------|
| `wd` | 搜索关键字（必填） |
| `source` | 数据源代码，默认如 `heimuer`；可为 `custom` |
| `customApi` | 自定义源 API 根地址（`source=custom` 时常见必填） |
| `customDetail` | 自定义详情相关（若前端有传） |

**`/api/detail`（常见）**

| 参数 | 含义 |
|------|------|
| `id` | 视频 ID（必填，格式校验见 `api.js`） |
| `source` | 数据源代码 |
| `customApi` | 自定义 API 根 |
| `customDetail` | 自定义详情页基址等 |
| `useDetail` | 自定义源时是否走特殊详情分支 |

具体分支以 `js/api.js` 为准；Node 侧应 **逐分支迁移并写集成测试或手工用例**。

### 4.4 服务端请求上游的两种方式

| 方式 | 做法 | 优点 | 注意 |
|------|------|------|------|
| A. 内部走本机 `/proxy` | Node 处理 `/api` 时用 `axios.get('http://127.0.0.1:' + PORT + '/proxy/' + encodeURIComponent(上游URL) + '?auth=' + hash + '&t=' + Date.now())` | 复用现有鉴权、UA、重试、流过滤逻辑 | 需正确计算 `auth`（与 `validateProxyAuth` 一致）；避免死锁（单进程一般无问题） |
| B. 在 `/api` 处理器里直接 `axios(上游URL)` | 不经过 `/proxy` | 少一跳 | 需在服务端处理 HTTPS、UA、部分站点封禁；与现 `proxy` 行为可能不一致 |

**推荐起步**：方式 A，与现网行为最接近；待稳定后再评估是否合并为直连以减延迟。

### 4.5 环境变量（与 `server.mjs` 对齐 + 扩展）

| 变量 | 作用 |
|------|------|
| `PORT` | 监听端口，默认 `8080` |
| `PASSWORD` | 站点密码；**不设时**现网代理会拒绝（见 `validateProxyAuth`）；生产务必设置 |
| `CORS_ORIGIN` | 前端跨域来源；生产建议设为具体前端域名而非 `*`（若带 Cookie） |
| `REQUEST_TIMEOUT` | 代理等请求超时 |
| `MAX_RETRIES` | 代理重试次数 |
| `NODE_ENV` | `development` 时静态资源缓存为 0 |
| `DEBUG` | 打印调试日志 |
| `BLOCKED_HOSTS` / `BLOCKED_IP_PREFIXES` | 限制代理目标，防 SSRF |

### 4.6 工程组织（二选一，细化）

**单仓扩展（适合个人维护）**

```
server.mjs                    # 入口：挂载 cors、static、proxy、再 app.use('/api', apiRouter)
server/
├── routes/
│   └── api.mjs               # express.Router：/search, /detail
├── lib/
│   ├── api-handlers.mjs      # 从 js/api.js 抽离的纯函数（需去掉 window、改用 node fetch/axios）
│   └── proxy-client.mjs      # 封装「带 auth 调本机 /proxy」
└── config/
    └── sites.mjs             # 由 js/config.js 迁出或构建时同步
```

**独立 API 仓库**

- 仅包含 `server/` 与 `package.json`；前端 `VITE_API_BASE` 指向 `https://api.xxx.com`。  
- 适合前后端不同人维护或不同发布周期。

### 4.7 生产部署示例片段

**Nginx 反代（示意）**

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

若 **前端静态与 API 分域名**：静态站只托管 `dist`，`location /api/` 与 `location /proxy/` 反代到 Node。

**PM2（示意）**

```bash
pm2 start server.mjs --name libretv-api --interpreter node
pm2 save
```

### 4.8 服务端验收清单（建议）

- [ ] `GET /api/search?wd=测试` 返回 JSON，`list` 为数组，与旧站在相同配置下可比。  
- [ ] `GET /api/detail?id=...&source=...` 返回 `episodes`、`videoInfo` 等字段，播放器可消费。  
- [ ] 未授权访问 `/proxy/...` 返回 401。  
- [ ] 压力与异常：上游超时、非 JSON 响应、空列表均有稳定 HTTP 状态与 body，不崩溃进程。

---

## 五、前后端协作与联调顺序（推荐）

1. **冻结接口**：根据 `js/api.js` 列出所有 query 与 JSON 字段，写成 `docs/api-contract.md` 或在代码里用 TypeScript 类型共享（monorepo 时）。  
2. **先迁 Node**：实现 `/api/search`、`/api/detail`，用 curl 验证。  
3. **再搭 Vue 壳**：只做搜索页 + 列表，接真接口。  
4. **详情与播放**：接 `episodes`，播放器用第一条 URL 冒烟。  
5. **边界**：自定义源、多源聚合、`source` 非法值等。  
6. **上安卓**：uni-app 打包，改 `VITE_API_BASE` 为公网 HTTPS，真机测播放与锁屏。

---

## 六、风险与注意（摘要）

- **版权与合规**：遵循项目 README，仅限学习及个人合法使用场景。  
- **SSRF**：代理接口必须持续使用 `isValidUrl` 一类校验；勿因迁 API 而绕过。  
- **密钥**：`PASSWORD` 仅服务端；不要把明文密码写进前端仓库。  
- **HTTPS**：安卓 9+ 对明文 HTTP 有限制；生产建议全链路 HTTPS。  
- **Vercel 无服务器**：仓库另有 `api/proxy/[...path].mjs` 等无服务器形态；若你长期用 **自托管 Node**，以 `server.mjs` 为准统一行为即可。

---

## 七、合规说明

LibreTV 项目 README 强调仅供学习及个人使用，并需遵守当地法律与内容授权。本文档仅作技术架构说明，部署与使用责任由部署者自行承担。
