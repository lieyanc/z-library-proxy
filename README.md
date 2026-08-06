# z-library-proxy

使用 Cloudflare Workers 将请求转发到 `https://z-lib.sk`。Worker 会保留请求方法、查询参数、请求体和 Cookie，并改写同源重定向、Cookie 域以及 HTML 中的同源绝对 URL。

## 功能

- `/` 使用精简搜索首页，不加载源站首页的其他模块。
- 开放资源搜索同时接入 Project Gutenberg 和 Open Library。Gutenberg 结果强制要求 `copyright=false`，Open Library 结果强制要求 `ebook_access=public` 和 `public_scan_b=true`。
- “授权书库”搜索进入源站结果页，登录、Cookie、详情和授权下载仍由源站处理。
- 源站搜索页注入精简工具栏并压缩广告、页脚等非核心区域。
- 页面出现 `ipfs://`、`/ipfs/<CID>` 或 `data-cid` 时提供 IPFS 网关测速。测速仅访问 `dweb.link`、`ipfs.io` 和 `w3s.link`，每个网关最多读取 64 KiB。
- 已加入授权列表的 CID 可通过当前 Worker 流式代理下载，支持 `HEAD`、`Range`、`ETag` 和网关故障切换；未授权 CID 只显示网关直连。

### 授权 IPFS 代理下载

为避免部署后成为任意内容代理，`ALLOWED_IPFS_CIDS` 默认为空。将你有权分发的根 CID 以逗号或空格分隔后写入 [`wrangler.jsonc`](./wrangler.jsonc)：

```jsonc
"vars": {
  "ALLOWED_IPFS_CIDS": "bafy... Qm...",
  "UPSTREAM_ORIGIN": "https://z-lib.sk"
}
```

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

部署成功后，每次向 `master` 推送提交都会自动发布；其他分支可生成预览版本。Worker 名称必须与 [`wrangler.jsonc`](./wrangler.jsonc) 中的 `name` 完全一致。

如需绑定自己的域名，在该 Worker 的 **Settings > Domains & Routes** 中添加 Custom Domain。源站地址位于 [`wrangler.jsonc`](./wrangler.jsonc) 的 `UPSTREAM_ORIGIN`，修改后提交到 Git 即会随下一次构建部署；该值必须是没有路径、查询参数和片段的 HTTPS Origin。

## 本地调试（可选）

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

Wrangler 默认在 `http://localhost:8787` 启动本地服务。源站当前可能返回 Cloudflare 验证或 `503`；本项目不会尝试绕过源站验证码、登录或其他访问控制。

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

- 只代理 `UPSTREAM_ORIGIN`，第三方 CDN、登录域名和跨域跳转不会被代理。
- HTML 采用流式属性改写；JavaScript 字符串和 CSS 文件内写死的源站地址不会被修改。
- IPFS 测速是 Cloudflare 边缘节点到网关的小样本结果，不等同于用户设备完整下载速度；公共网关也没有可用性保证。
- 代理下载会消耗 Worker 请求时长和出站流量，大文件仍受 Cloudflare 套餐及平台限制影响。
- Cloudflare Workers 不能保证通过另一个 Cloudflare 站点的 Bot Management 或交互式验证。
- 部署和使用时应遵守 Cloudflare 条款、源站条款以及所在地适用法律，仅代理你有权访问和传输的内容。
