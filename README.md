# z-library-proxy

使用 Cloudflare Workers 将请求转发到 `https://z-lib.sk`。Worker 会保留请求方法、查询参数、请求体和 Cookie，并改写同源重定向、Cookie 域以及 HTML 中的同源绝对 URL。

## 功能

- `/` 使用精简搜索首页，不加载源站首页的其他模块。
- 开放资源搜索同时接入 Project Gutenberg 和 Open Library。Gutenberg 结果强制要求 `copyright=false`，Open Library 结果强制要求 `ebook_access=public` 和 `public_scan_b=true`。
- Z-Library（授权书库）为默认搜索模式，不跳转源站页面：Worker 在服务端抓取并解析源站结果页（`<z-bookcard>`），以自有界面渲染；点击结果弹出书籍详情对话框（元数据、简介、下载入口、IPFS 网关测速），封面经 `/__z/cover` 同源代理。登录、Cookie 和授权下载仍由源站处理。搜索词非空时再次点击已选中的“Z-Library”切换钮，可选择跳转到 `/s/<关键词>` 以源站原始样式渲染。
- 源站反爬挑战（SHA-1 PoW）由浏览器本地求解：Worker 遇到挑战时把挑战参数连同该次响应签发的 `bsrv` 粘性 Cookie 一起以 JSON 下发（503 + `challenge`），前端求解后经 `POST /__z/api/challenge` 回传 token 与 `bsrv`（源站只接受与同次 503 配对的 `bsrv` + `c_token`），Worker 以 `Set-Cookie` 把配对好的会话种在浏览器侧，后续 API 请求自动携带并转发上游——Worker 本身无状态，不受 isolate 切换影响；全程自动，前端显示“正在通过人机验证…”。Worker 也内置了 WebCrypto 求解器作为代理页面流的兜底，并对 429/502/503/504 做退避重试（429 是源站对共享 Cloudflare 出口 IP 的限流，重试常会落到更健康的出口上）；每次上游请求受整体超时预算约束，单个卡住的尝试（tarpit）只消耗自己的超时，不会吞掉后续重试。
- 源站搜索页注入精简工具栏并压缩广告、页脚等非核心区域。
- 页面出现 `ipfs://`、`/ipfs/<CID>` 或 `data-cid` 时提供 IPFS 网关测速。测速仅访问 `dweb.link`、`ipfs.io` 和 `w3s.link`，每个网关最多读取 64 KiB。
- 部署感知自刷新：构建时把当前 git commit 注入 `src/assets.generated.js`，首页 HTML（`no-store`）经 `data-commit` 下发，前端轮询 `/__z/api/version`，发现 commit 变化即自动 `location.reload()`；静态资源 URL 带内容哈希 `?v=`，标题栏仓库名旁显示 `@<commit>` 链接。
- 已授权的 CID 可通过当前 Worker 流式代理下载，支持 `HEAD`、`Range`、`ETag` 和网关故障切换；未授权 CID 只显示网关直连。

### 内置 API

- `GET /__z/api/version` — 当前构建的版本信息（`{version, commit}`，`no-store`），供前端检测部署。
- `GET /__z/api/search?q=<关键词>` — 开放资源搜索（Project Gutenberg + Open Library，JSON）。
- `GET /__z/api/zsearch?q=<关键词>&page=<页码>` — 源站搜索结果（JSON）。源站挑战时返回 `503 + {challenge}`。成功结果写入 Cache API 缓存 5 分钟、同关键词的并发请求合并为一次上游抓取（热门词和重复点击不再消耗上游限流额度）；失败与挑战结果一律不缓存。
- `GET /__z/api/zbook?path=/book/<id>/<slug>.html` — 书籍详情（元数据、IPFS CID、下载路径、数字书籍 ID、是否已配置下载账户）。挑战时同样返回 `503 + {challenge}`。
- `GET /__z/api/zformats?id=<数字书籍ID>` — 同一本书的其他可选格式（转发上游 `/papi/book/<id>/formats`），每项含扩展名、文件大小和 `/dl/<hash>` 下载路径，下载仍走 `/__z/dl/` 中转。挑战时同样返回 `503 + {challenge}`。
- `POST /__z/api/challenge` — 提交浏览器求解的 `{token, seconds, bsrv}`，校验后以 `Set-Cookie` 种入浏览器持有的上游会话（`z_zlib_session`，HttpOnly）。
- `GET /__z/cover?u=<封面URL>` — 封面图代理，仅允许 `covers.z-lib.sk` / `covers.z-library.sk`。
- `GET /__z/api/ipfs-probe?cid=<CID>&path=<可选路径>&filename=<可选文件名>` — IPFS 网关测速（JSON），返回各网关延迟、样本速度，以及 CID 已授权时的 `/__z/ipfs/` 代理下载地址。
- `GET /__z/dl/<hash>` — 账户下载中转：用已配置的账户会话解析 `/dl/<hash>` 的 302 签名 CDN 地址并流式回传文件（支持断点续传式开放 Range），未配置账户时返回 501。

PoW 求解（平均约 6.5 万次 SHA-1）默认在浏览器本地完成，Worker 零 CPU 负担，免费版即可运行；Worker 内置的 WebCrypto 兜底求解器（`crypto.subtle` 不计入 CPU 时间）只服务直接访问代理页面的场景。

### 源站账户会话（下载用）

详情弹窗的“下载”按钮需要源站账户才能解析真实文件地址。把账户会话 Cookie 配置为环境变量 `ZLIB_ACCOUNT_COOKIES`：

```text
remix_userid=<你的 userid>; remix_userkey=<你的 userkey>
```

- 该值**只**在 `/__z/dl/` 下载解析和 `/__z/api/zformats` 格式列表请求中发送给源站，不会下发给访客，也不会用于搜索、详情等其他请求。
- 生产环境请在 Cloudflare 控制台（Workers & Pages → 本 Worker → Settings → Variables and Secrets → Type 选 **Secret**）添加 `ZLIB_ACCOUNT_COOKIES`，或执行 `npx wrangler secret put ZLIB_ACCOUNT_COOKIES`。Secret 不会被后续 Git 部署覆盖。本地开发写入 [`.dev.vars`](./.gitignore)（已 gitignore）。
- 不要把真实值提交进 `wrangler.jsonc` 或任何会被推送的文件——`remix_userkey` 等同于账户密码。仓库为私有且你确认可接受时，也可以选择直接写入 `wrangler.jsonc` 的 `vars`。
- 未配置时，下载按钮回退为源站 `/dl/` 链接（访客自行登录源站）。

### 授权 IPFS 代理下载

`ALLOWED_IPFS_CIDS` 支持以逗号或空格分隔的根 CID 白名单，也支持 `*` 放行任意格式合法的 CID。当前部署使用 `*`，以便详情页动态返回的 IPFS CID 可以直接下载；如果站点对外开放且只分发固定内容，应改为精确 CID 列表：

```jsonc
"vars": {
  "ALLOWED_IPFS_CIDS": "bafy... Qm...",
  "UPSTREAM_ORIGIN": "https://z-lib.sk"
}
```

设置为空字符串会完全关闭 Worker IPFS 代理下载，仅保留公共网关直连。

提交并推送后，Cloudflare Workers Builds 会自动部署新授权列表。代理下载地址格式为：

```text
/__z/ipfs/<CID>?gateway=dweb&path=optional/file.epub&filename=book.epub
```

Worker 只连接代码中固定的三个 IPFS 网关，不接受自定义上游地址，也不会向网关转发浏览器 Cookie 或 Authorization。

## 通过 Git 自动部署（推荐）

本仓库已包含 Cloudflare Workers Builds 所需的 `package.json`、`wrangler.jsonc` 和 Worker 入口，可以直接在网页端绑定 GitHub 或 GitLab：

1. 将仓库推送到 GitHub 或 GitLab。
2. 打开 Cloudflare Dashboard 的 **Workers & Pages**，选择 **Create application**。
3. 在 **Import a repository** 旁选择 **Get started**，授权 Git 账号并选择本仓库。
4. 按下表填写构建配置，然后选择 **Save and Deploy**。

| 配置项 | 值 |
| --- | --- |
| Worker name | `z-library-proxy` |
| Production branch | `master` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Non-production branch deploy command | `npx wrangler versions upload`（默认值） |
| Root directory | `/`（默认值） |

仓库不会在 lockfile 中固定 npm registry。本机可通过 `npm config set registry https://registry.npmmirror.com/ --location=user` 使用 npmmirror；Cloudflare Workers Builds 默认使用 npm 官方源，也可在 **Settings > Build > Build Variables and Secrets** 中显式设置 `NPM_CONFIG_REGISTRY=https://registry.npmjs.org/`。

部署成功后，每次向 `master` 推送提交都会自动发布；其他分支可生成预览版本。Worker 名称必须与 [`wrangler.jsonc`](./wrangler.jsonc) 中的 `name` 完全一致。

如需绑定自己的域名，在该 Worker 的 **Settings > Domains & Routes** 中添加 Custom Domain。源站地址位于 [`wrangler.jsonc`](./wrangler.jsonc) 的 `UPSTREAM_ORIGIN`，修改后提交到 Git 即会随下一次构建部署；该值必须是没有路径、查询参数和片段的 HTTPS Origin。

## 本地调试（可选）

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

Wrangler 默认在 `http://localhost:8787` 启动本地服务。源站当前可能返回 `503` 反爬挑战页（SHA-1 PoW）；Worker 会尝试在服务端求解，失败时透传给浏览器完成。本项目不会尝试绕过源站验证码、登录或其他访问控制。

### 前端开发

`/` 首页搜索界面是 [`frontend/`](./frontend) 下的 React + shadcn/ui（Tailwind CSS v4）单页应用。`npm run build` 会先执行 Vite 构建，再由 `scripts/generate-assets.mjs` 把 `frontend/dist/assets/app.js` 与 `app.css` 内嵌为 `src/assets.generated.js`（已加入 `.gitignore`），Worker 继续通过 `/__z/assets/app.js|css` 提供服务；`npm test`、`npm run deploy` 和 `npm run check` 都会自动先执行该构建。

前端日常迭代可以另开一个终端运行 `npm run dev:frontend` 启动 Vite 开发服务器（默认 `http://localhost:5173`），它会把 `/__z` 开头的接口代理到 `wrangler dev` 的 `http://localhost:8787`。注入源站页面的工具栏与 IPFS 对话框仍为 `src/ui.js` 中的轻量原生脚本，不经过前端构建。

## 命令行部署（可选）

```bash
npx wrangler login
npm run deploy
```

部署完成后，Wrangler 会输出一个 `workers.dev` 地址。此方式仅作为 Git 自动部署之外的手动发布选项。

## 限制

- 只代理 `UPSTREAM_ORIGIN`（外加白名单封面域名），第三方 CDN、登录域名和跨域跳转不会被代理。
- HTML 采用流式属性改写；JavaScript 字符串和 CSS 文件内写死的源站地址不会被修改。
- 挑战求解器依赖源站挑战页的具体格式，源站调整挑战算法后需要同步更新 `src/challenge.js`。
- IPFS 测速是 Cloudflare 边缘节点到网关的小样本结果，不等同于用户设备完整下载速度；公共网关也没有可用性保证。
- 代理下载会消耗 Worker 请求时长和出站流量，大文件仍受 Cloudflare 套餐及平台限制影响。
- 部署和使用时应遵守 Cloudflare 条款、源站条款以及所在地适用法律，仅代理你有权访问和传输的内容。
