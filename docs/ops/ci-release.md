# CI 与 GHCR 发布 runbook（issue #235）

> 面向：主 agent / 运维。覆盖 `.github/workflows/ci.yml`（质量门禁 + 镜像构建校验）与
> `.github/workflows/release.yml`（tag → GHCR 三镜像 + digest 清单）。
> 不替代：`docs/design/deploy-contract.md`（应该是什么样）、`docs/env.md`（参数口径）、
> `docs/ops/deployment-2026-10-10.md`（实际部署成了什么样）。
>
> 三条硬口径：**① 只用 `ubuntu-latest` 单一运行器（禁止 matrix）；② 镜像名全小写；
> ③ 推送关 provenance/sbom，digest 要能和部署机 `docker image inspect .Id` 对上。**

---

## 1. 触发口径表

| 触发 | 跑什么 | 预计分钟量级（Linux `$0.006/min`） |
|---|---|---|
| `pull_request` | 只跑门禁：语法保底 → 根测 → runner 测 → 前端 typecheck+test | 3–5 min（大头是 checkout/setup-node/三次 npm ci，测试本身 ~25s） |
| `push`（main） | 门禁 + **按路径过滤**的镜像构建校验（`--load`，**不推送**） | 门禁 3–5 min + portal 3–6 min / fde-proxy <1 min / **FDE 冷构建 10–15 min** |
| `push`（tag `v*`） | `release.yml`：版本校验 + 三镜像构建并推 GHCR + digest 清单 | 15–25 min（FDE 镜像体积大，推送占大头；GHCR 带宽目前免费） |
| `workflow_dispatch`（ci.yml） | 门禁；`build_images=all` 时追加三镜像构建校验 | 同上 |
| `workflow_dispatch`（release.yml） | 手填 `tag`，跑与 tag push 完全相同的发布流程 | 同上 |

**门禁步骤（顺序执行，任一失败即红；`ci.yml` 步骤 ①、①′、②–④）**

1. （步骤 ①）`node --check` 扫全部 git 跟踪的 `*.js` / `*.mjs`（当前 142 个文件，按 `git ls-files -- '*.js' '*.mjs'` 实测；
   仓库 `type: module`，`node --check` 会按 `package.json` 的 type 解析，ESM 文件实测 rc=0）。
2. （步骤 ①′）**运行身份诊断**：`id -u` / `id -g` / `id` / `uname -a`（无 `continue-on-error`、无 `if: always()`）。
   为什么要这一步：属主类断言的成败完全取决于 runner 进程的 uid/gid（见 §8 第 1 条），
   有这四行就不用再猜「今天的 runner 是谁」。
3. （步骤 ②）根 `npm ci` + `npm test` → **1022 项 / 1021 通过 / 0 失败 / 1 跳过**（基线，2026-10-13 本机复现；`#277-A`+`#277-A2` 被停止的 queued run 直接终态 **+17**，全在新文件 `portal/test/session-stop-queued.test.js`：第一步 queued→finished/aborted+出队+会话解锁 9 项，A2 的「已领走未写 running 落 cancelling」守卫 4 项与「同事务合成 `run_end`」4 项（含重复停止只一条、与 runs 终态同事务的源码级断言）；`#255` 强制首登改密后端片 **+29**：新文件 `portal/test/must-change-password.test.js` 28 项（迁移语义 / 代设口令置旗标 / `POST /api/me/password` / 受限会话门与 9 条放行清单 / 登录响应 `password_change_required` / 文档防漂移）+ `portal/test/migrations.test.js` 0021 断言 1 项；`#275` 预览 released 历史行遮蔽活行的 **+7**，全在 `portal/test/preview.test.js`：同 hostname 遮蔽回归 2 + 契约锁 3（只有 released 行仍 403 / `released_at` 同值靠 `id` 成全序 / 查不到 404）+ fake 自证部分唯一索引 1 + 源码级护栏 1；
   原 945/944 基线上新增 `#234`（工单 `feat-261013-01`，跨站写请求防线 Origin / `Sec-Fetch-Site` 同源校验）的 **24 项**（同分支返修 +2，见下）：
   全部在新文件 `portal/test/csrf-origin.test.js`（13 项纯判据：`checkSameOrigin` / `csrfGateFor` 的 a/b/c/d 四支 +
   **返修回归门：`same-site` 不得直接放行、必落 Origin 比对** +
   默认端口/非默认端口归一化 + IPv6 + `X-Forwarded-Host` 优先级 + 畸形 Origin + 豁免端点；
   11 项 HTTP 层：issue 明写的「跨站 POST 带 cookie ⇒ 403 `cross_origin_forbidden`」并断言**拒绝发生在副作用之前**、
   同源 200、无 Origin 放行、`cross-site` 无 Origin 拒、`same-origin` 无 Origin 放行、
   **预览 host 带 `same-site` 写 portal API ⇒ 403（返修回归门，带两个放行对照：Origin 相等 / Origin 缺失）**、
   GET/SSE/HEAD/OPTIONS 不受影响、
   `/api/internal/*` 与 `/api/forward-auth` 豁免、dev `:8090` 形态端口匹配与不同端口拒绝、畸形 Origin 在 HTTP 层就拒、
   拒绝响应带 ACAO/ACAC/Vary 且状态码仍 403、审计 `auth.csrf_denied` 的 details/target/失败不阻断）。
   变异自证（各自只红相关处）：删掉 `cross-site` 分支 ⇒ 4 红；Origin「解析失败即放行」⇒ 3 红；端口一律丢掉 ⇒ 5 红；
   **返修后另两枚（本单）：删掉判据 b 的 `same-origin` ⇒ 1 红（证 b 未成空壳）；把 `same-site` 短路回直接放行
   ⇒ 只有新增的两枚回归门红（纯判据 + HTTP 层），其余 22 全绿——钉住「同注册域不同 origin 被洗白」这个缺陷本体。**
   （返修前本行为 **967/966（22 项 = 12 纯 + 10 HTTP）**：`same-site` 直接放行的缺陷修掉后，原「判据 b：`same-site`
   放行」那枚按新口径改写为「落 Origin 比对后的三种结局」（不删除），并新增纯判据与 HTTP 层各 1 枚回归门 ⇒ +2。）
   原 926/925 基线上新增 `#261`（runner 显式 LLM 三相超时）的 **19 项**：
   `runner/test/llm-timeouts.test.js` +19（helper env 解析 / **回归门：`explicitPhase=true` 且 `legacyTimeoutMs=undefined`**
   ——钉的是「关掉引擎 legacy 120s 总闸」这个机制本身，对照组钉「`timeoutMs:900000` 这种直觉修法根本不关闸」/
   虚拟时钟行为门（legacy 有 chunk 回流仍被杀 vs 四相全活）/ `0`·`false`·`Infinity` 三个秒死陷阱实测钉 /
   worker 源码级钉 + docs/env.md 文档钉）；
   原 920/919 基线上新增 `#257 + #258`（工单 `feat-261012-01`，告知面单一真相落 `~/AGENTS.md`）的 **6 项**：
   `portal/test/materializer.test.js` +4（预览访问 6 条逐条锚点 / 错误形态对照 / 红线：零端口数字与区间、
   零伞域字面量 / `isPlatformManagedPath` 认 home 级 `AGENTS.md` 是平台文件）、
   `runner/test/system-prompt.test.js` +2（强制指针：措辞必须「先读」且同段自带 shell 读法 /
   单一来源防漂移：提示词里不得出现 `allowedHosts`·`credentials`·`CORS` 三个具体规则词，并反向断言它们必须在
   单一真相里）；同文件另**只加不减地扩了既有断言**（端口红线从「数字+区间」扩到按形状禁任何多段域名字面量）。
   再往前：原 910/909 基线上新增 `#252`（工单 `fix-261011-B`）撤预览 grant 只撤 `active` 的 **10 项**：
   `portal/test/preview-ports.test.js` +3（只撤 active / 谓词源码断言 / fake 真会拦 23514）、
   `portal/test/offboarding.test.js` +5（只撤 active / **重试路径** / 撤 0 行 / 旧谓词 23514 / 整笔回滚）、
   `portal/test/migrations.test.js` +1（0020 静态断言）、`portal/test/preview-grant-checks.js` +1
   （**这是 fake 共用的 CHECK 规则文件，本身没有用例**——见下面的发现规则，`test/` 目录下的每个 `.js` 都占 1 项，
   `fake-pool.js` 那三个 helper 同理，别把它当成一条真用例）；
   再往前是 `#246 交付②` 预览端口列端点与管理员改块的 21 项（`portal/test/preview-ports.test.js`）、
   `#246` 交付① 预分配号池块的 15 项（`portal/test/portalloc.test.js` 与 `portal/test/{migrations,materializer}.test.js`）
   与 `#241` 预览预检与 deny CORS 的 7 条。
   ⚠️ 根 `node --test` 的发现规则会把 `runner/test/*.test.js` 一起收进来 ⇒ **1022 里已含 runner 的 221 项**。
   ⚠️ 同一条发现规则（`**/test/**/*.js`）也会把 `portal/test/` 下的**非用例 helper**算成 1 项 ⇒ 净增用例数
   要按上面的拆解核对，别只看总数（实测：在 `portal/test/` 放一个空的 `x.js`，总数立刻 +1）。
4. （步骤 ③）`cd runner && npm ci && node --test` → **221/221**（#261 新增 19 项 `runner/test/llm-timeouts.test.js`；
   再往前 #257+#258 新增 2 项在 `runner/test/system-prompt.test.js`，那之前是 200/200）。口径见 `AGENTS.md` §4：
   **`node --test runner/test/`（目录当参数）在本机 Node 22/24 是坏的**（把目录当模块加载 → `Cannot find module`），别用。
5. （步骤 ④）`cd portal/frontend && NODE_ENV=development npm ci && npm run typecheck && npm test` → typecheck 干净 + **30 文件 / 431 通过**（#255 前端①「强制首登改密屏」起 410→431：新文件 `views/ForcePasswordChangeView.spec.ts` 21 条 —— 闸门渲染、「关不掉」（无 dialog/遮罩/关闭按钮且改 URL 也进不去）、深链刷新重建、`/login` 不是绕过口、成功链路必须重新 `GET /api/me`（禁止本地清旗标）、**false 一切照旧**、双语键集逐字一致、`toDisplayText` 的 `[object Object]` 反证；旧 29 文件一字未改仍全绿。#261B「重试上一条」起 391→410（`workbench.spec` +8 状态机/守卫、`ComposerBar.spec` +7 三态渲染与转发、`useEventStream.spec` +4 横幅 errorCode 两态与 i18n 同形）；后端与 runner 基线不变（1022 / 221）。
   `NODE_ENV=development` 是**必需**的：devDependencies（vite/tailwind/vitest）在 `NODE_ENV=production` 下会被 `npm ci` 跳过。
   基线拆解：**23 文件 / 329 通过**（#246 交付② 单 A 与 #252 时的基线）+ `#246 交付② 单 B`（工单 `feat-261011-B2`，纯前端）净增 **6 文件 / 62 项**：
   预览端口面板的端点与票 URL 拼装 15（`src/lib/previewPorts.spec.ts`）、数据层（签票时机 / 新标签地址 / 改块 body）12
   （`src/composables/usePreviewPorts.spec.ts`）、列表四态与 `state` 口径 13（`src/components/PreviewPortsPanel.spec.ts`）、
   工作台区块（进视图拉列表 + **未点击不得签票**）6（`src/views/WorkbenchPreviewPorts.spec.ts`）、
   管理台改块（**未确认不得发 POST** / 409 全文 / 400 指 `block_start`）10（`src/views/AdminPreviewPorts.spec.ts`）、
   i18n 双语键集对齐 6（`src/i18n/localeParity.spec.ts`）。既有 329 项一条没改、一条没红。

**镜像构建校验的路径过滤（`ci.yml` 步骤 ⑤）**

| 镜像 | 构建上下文 / Dockerfile | 触发路径 |
|---|---|---|
| portal | context `.`（仓库根）+ `portal/Dockerfile`（= `deploy/docker-compose.yml:111-113` service `station-portal`） | `portal/**`、`package.json`、`package-lock.json`、**`docs/data/**`、`deploy/migrations/**`、`.dockerignore`** |
| FDE | context `runner/`（= `portal/integration/lib/fde-image.mjs:36` 的 `build -t <img> runner/`） | `runner/**` |
| fde-proxy | context `deploy/fde-proxy`（= `deploy/docker-compose.yml:63-65` service `station-docker-proxy`） | `deploy/fde-proxy/**` |

- 后三类是**按仓库实际补的**：`portal/Dockerfile:31` COPY 了 `docs/data/`、`:34` COPY 了 `deploy/migrations/`、
  根 `.dockerignore` 参与 context `.` 的上下文计算 ⇒ 它们变了镜像内容就变，不构建校验就是假绿。
  （工单原表只列了 `portal/**` + 根 `package*.json`。）
- **纯 docs 提交不构建任何镜像**（`docs/**` 除 `docs/data/` 外都不在触发集里）。
- 推入前的 commit 在本地历史里找不到（新分支首推 / force push）⇒ 保守起见三个全构建。
- CI **不传** `HTTP_PROXY/HTTPS_PROXY/NO_PROXY` build args，也不加 `--network=host`：
  `runner/Dockerfile:55-74` 那层从 github.com / dl.gitea.io / gitlab.com 直连下 gh/tea/glab，
  本开发机在墙内必须走代理（`fde-image.mjs:26-40`），GitHub runner 直连可达；
  而 **build args 参与 Docker 缓存键** ⇒ CI 恒不传，缓存键保持稳定。

---

## 2. 发布 → 部署（digest pin）

**流程一览**

```
① 对齐版本号（§7）→ ② git tag vX.Y.Z && git push --follow-tags（本沙箱里 = 主 agent cherry-pick 后推）
→ ③ release.yml 推三镜像，job summary / artifact `images-digest` 给出 digest 清单
→ ④ 部署机改 deploy/.env 三个 IMAGE 变量为不可变 pin → ⑤ docker compose up -d
→ ⑥ 换了 FDE 镜像还要重建 FDE 容器（见下面第 5 条）
```

**前置（部署机，只做一次）：`docker login ghcr.io`**

```bash
# 用户名 = GitHub 用户名；口令 = PAT（classic 勾 `read:packages`；
# fine-grained 需给目标仓库 `Package: Read` + `Contents: Read`）
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u ErixWong --password-stdin
docker pull ghcr.io/erixwong/erix-station-fde-proxy:latest   # 能拉过 = 登录到位
```

⚠️ 仓库 `ErixWong/erix-station` 是**私有**的 ⇒ 首次推送时建的 GHCR 包默认也私有，**未登录拉不动**，
报 `denied: requested access to the resource is denied`——别误判成「镜像没推上去」（先看 Actions run 是否绿）。
凭据落在 `~/.docker/config.json`；换 PAT 后需重登。

1. **发布**：`git tag v0.2.0 && git push --follow-tags`。`release.yml` 校验
   `tag` 去掉 `v` 后必须等于 `package.json` 的 `version`，不等就**明确失败并打印两者当前值**。
2. **拿 digest**：三个来源任选（内容一致）——
   - `release.yml` 的 **job summary**（含可直接贴进 `deploy/.env` 的三行）；
   - artifact **`images-digest`** 里的 `images-digest.json`；
   - 若该 tag 已建 GitHub Release，同名文件会挂在 Release 附件上（tag push **不会**自动建 Release；
     要挂就先 `gh release create vX.Y.Z --notes '...'`，再用 `workflow_dispatch` 重跑 `release.yml`）。
3. **更新部署机 `deploy/.env`**（600 权限、不入库）：

   ```bash
   STATION_PORTAL_IMAGE=ghcr.io/erixwong/erix-station-portal@sha256:<digest>
   FDE_IMAGE=ghcr.io/erixwong/erix-station-fde@sha256:<digest>
   STATION_DOCKER_PROXY_IMAGE=ghcr.io/erixwong/erix-station-fde-proxy@sha256:<digest>
   ```

   ⚠️ **prod 模式（`FDE_DEV_MODE=0`）只接受两种形态**，否则 portal 拒启（`portal/src/config.js:121-123`）：
   - 形态① `image@sha256:<64hex>`（manifest digest，`images-digest.json` 的 `digest`）；
   - 形态② `sha256:<imageId>`（config digest，= 部署机 `docker image inspect --format '{{.Id}}'`；清单里的 `imageId`）。
   清单里两种都给了，任选；混用会核对不上（§3）。
4. **起栈**：`docker compose -f deploy/docker-compose.yml up -d`（compose 默认 tag 仍是 `:local`，
   **不设 env 就还是本地镜像**，CI/CD 不会自己改变部署形态；`FDE_IMAGE` 同时是 proxy 的 `IMAGE_ALLOWLIST`，
   `deploy/docker-compose.yml:93`，改 FDE pin 时两处同源，不用单独改 proxy 白名单）。
5. **换 FDE 镜像必须显式重建容器**：`ensureFdeContainer`（`portal/src/provisioner.js:305-322`）
   **只在容器不存在时创建**，不因镜像变化重建。

   ```bash
   docker rm -f fde-<name>
   docker compose -f deploy/docker-compose.yml exec -T station-portal \
     node portal/src/cli.js provision-fde --fde-name <name>
   docker inspect -f '{{.Image}}' fde-<name>   # 应等于新 imageId（sha256:<...>）
   ```
6. **核对**：`docker image inspect --format '{{.Id}}' <拉下来的镜像>` == 清单里的 `imageId`；
   `docker inspect -f '{{index .RepoDigests 0}}' <镜像>` 可取形态①用的 repo digest。

---

## 3. digest 语义：为什么必须 `--provenance=false --sbom=false`

- 开启 attestations（`docker/build-push-action@v6` 的 **provenance 默认是开的**）时，推上去的 digest 指向
  **attestation index**（子清单里除镜像外还有 provenance/sbom），它**不等于**部署机
  `docker image inspect --format '{{.Id}}'`（那是 **config blob 的 digest**）⇒ 我们拿 `.Id` / `@sha256:` 当部署 pin
  （`portal/src/config.js:119-123` 两形态门），人肉核对会永远对不上。
- 关掉后推的是**单张 image manifest**，其 `config.digest` 就是部署机看到的 `.Id`。本机实测等价性：
  `docker save` 出来的 `blobs/sha256/<Id>.json` **文件名就是 `.Id`**，且该文件内容的 sha256 又等于该文件名
  （内容寻址）⇒ `manifest.config.digest == docker image inspect .Id`。
- `release.yml` 步骤 ⑦ 因此记两样：`digest`（manifest，形态①）+ `imageId`（config，形态②），
  并用 `docker buildx imagetools inspect --raw` 现场读 registry manifest；若发现 manifest 里还挂着
  attestation 子清单，会在日志里显式警告（provenance/sbom 没关掉）。
- 步骤 ③ 用 `docker/setup-buildx-action`（docker-container 驱动）的原因：**默认 `docker` 驱动直接拒绝 attestation**
  （本机实测 `--provenance=true` → `Attestation is not supported for the docker driver`），
  在那个驱动下 `provenance/sbom` 开关形同虚设，也就无法保证「关掉」。
- `ci.yml` 的构建校验用 `docker buildx build --load`（默认 docker 驱动），产物只在本地、不推送，不存在 digest 问题。
- 单架构 `linux/amd64`，标签 `<version>` + `latest`；**不推 `:local`**、不改 compose 默认 tag。

---

## 4. 账号预算语义（超额是**停跑**，不是扣费）

- GitHub Free；Linux `$0.006/min`、Windows `$0.01/min`、**macOS 3-core `$0.062/min`（≈10 倍）**
  ⇒ 所以 workflow 里**没有 matrix、没有 macos/windows runner**，这是红线。
- **Actions 与 Packages 预算都是 `$0` 且 `Stop usage = Yes`** ⇒ 超额**不扣费而是停跑**。
  后果：**CI 可能月中被静默停掉，界面上没有红灯**（不会失败，只是不跑）。
  排查习惯：main 上提交后**确认 CI run 真的存在**；没有 run 就按下面的兜底人工复跑。
- Actions 存储（artifacts + cache）与 Packages 通用配额**共享 500MB** ⇒
  `release.yml` 的 artifact 只放一个 `images-digest.json`（<2KB，保留 14 天）；
  `ci.yml` 不放 artifact、不开 `setup-node` 的 npm 缓存、不开 buildx `type=gha` 缓存
  （三次 `npm ci` 热缓存共 ~3s，省这点秒数不值配额风险；真要加缓存先确认它不会把 500MB 吃穿）。
- **兜底 = 人工在本地复跑同一套门禁**（与 `ci.yml` 步骤 ①–④ 一一对应，仓库根执行）：

  ```bash
  # ① 语法保底
  git ls-files -z -- '*.js' '*.mjs' | xargs -0 -n1 node --check
  # ①′ 运行身份诊断（属主类失败先报这个）
  id -u; id -g; id; uname -a
  # ② 根单测
  npm ci && npm test
  # ③ runner 单测（别用 `node --test runner/test/`）
  ( cd runner && npm ci && node --test )
  # ④ 前端（NODE_ENV 必须非 production）
  ( cd portal/frontend && NODE_ENV=development npm ci && npm run typecheck && npm test )
  ```

  镜像构建校验的本地兜底：`docker buildx build --load -t x .`（portal，`-f portal/Dockerfile`）、
  `docker buildx build --load runner/`（FDE，本机需先按 `fde-image.mjs` 的口径传代理 + `--network=host`）、
  `docker buildx build --load deploy/fde-proxy`。

---

## 5. GHCR 为什么免费、以及退路

- 原文依据：GitHub Docs 对 **container packages** 的存储与带宽写的是 **"currently free of charge"**
  （政策变化会提前 **≥1 个月**通知）；收费的是通用 Packages 配额（Actions cache/artifacts + 非容器包），
  即 §4 里那个 500MB。我们推的三类都是 **container image** ⇒ 落在免费侧。
- **退路**：一旦开始计费，改推本机自托管 **`registry:2`**（数据目录按全局约定放 `/docker/registry`），
  compose 的 `FDE_IMAGE` / `STATION_PORTAL_IMAGE` / `STATION_DOCKER_PROXY_IMAGE` 换成
  `127.0.0.1:<port>/...@sha256:<digest>`（或 `registry:5000/...`，`portal/src/config.js:104-114` 的
  registry host 判定接受带端口的 host）。
  **代价**：GitHub Actions **推不进 NAT 后的本机**（没有到本机的入站通道）⇒ 届时**构建也回本机**，
  CI 退回「只跑门禁」，镜像构建/推送改成本机脚本 + 同一个 digest 清单口径。

---

## 6. e2e 为什么不进 CI

`portal/integration/wp*-e2e.mjs` 不进 CI，理由都是硬依赖：

1. 需要 **docker daemon + 起整栈**（postgres / traefik / litellm / portal / proxy / 真 FDE 容器）。
2. **按栈派生的 IPAM 池**（#227.3，取代旧「恰为 `['10.201.0.0/16']`」等值口径）：
   `assertIsolatedEnvironment()`（`lib/isolated-env.mjs`）硬断言 `FDE_IPAM_POOLS` 每一段都在隔离族
   `10.201.0.0/16–10.299.0.0/16` 内，共享段 `10.200.0.0/16` 一律拒；正规值由
   `deriveFdeIpamPools(STATION_STACK_ID)` 按栈 id 数字 mod 99 确定性派生（族外/含共享段的显式覆盖都拒，
   族内显式覆盖放行作为撞段逃生口）。⚠️ portal 侧分配钉死在 `POOLS.large`（`portal/src/ipam.js:14`，
   非 env 可配），proxy 白名单必须包含 `10.201.0.0/16`，所以脚本缺省注入 `defaultFdeIpamPools`
   （派生段+large 池段）。护栏还断言一堆隔离栈专属 env（容器名、端口、`FDE_DEV_MODE=1`（tag 形态
   FDE 镜像必需，#227.1）、`STATION_DB_DIR` 必须在临时目录且**不存在**）；GitHub runner 上没有这套网络前提。
3. 需要**泛域名解析 + Tailscale**（`*.fde.erix.vip` → `100.100.0.3`）与宿主 Traefik host 网络。
4. 分钟成本：一条 e2e 链路跑下来在 CI 里要占十几分钟，Free 额度撑不住（§4）。

**口径**：e2e 由**主 agent 在部署机上、本机隔离栈**跑（`wp2a` / `wp3a` / `wp3b` / `wp5` / `wp6`），**部署前**执行；
CI 只保证「语法 + 单测 + 类型 + 镜像能构建出来」。其中 `wp2a` 已按 #268 决策第 2 条重建为「FDE 开户 →
userspace/端口下发对账 → 预览签票链路 → 去置备 + offboarding 收敛」的小包（工单 F，旧形态里「POST
/api/projects → 项目级 ports.json → 删项目回收端口」的断言对象已从产品里消失），与其余几支共用
`lib/isolated-env.mjs` 的隔离护栏 / Traefik 静态配置 / edge watch 桩，另加 `lib/ports-reconcile.mjs`
（`~/.erix/ports.json` ↔ `port_allocations` 逐条对账件）；静态口径由 `portal/integration/isolation-negative.mjs`
钉住（它不在 `node --test` 发现面里，缺省 rc=1 是负例证据本体，进 CI 用 `--strict`）。

---

## 7. 首次发布前置：版本对齐（**现状会被拦住，属预期**）

- 现状：`package.json = 0.1.0`、`runner/package.json = 0.1.0`，但 git tag 已到 **`v0.1.1`**（历史遗留不一致）。
  ⇒ 直接拿 `v0.1.1` 跑 `release.yml` 会在步骤 ① **失败**（同时打印两者当前值）。本工单**没改**版本号。
- 发布前动作（一次改齐，别只改一个）：
  1. `package.json` 的 `version` = 目标版本（**这是硬门**）；
  2. `runner/package.json`（FDE 镜像与宿主引擎同源，`release.yml` 只警告不阻断）；
  3. `portal/frontend/package.json`（纯展示，建议一并对齐）。
  然后 `git commit` → `git tag vX.Y.Z` → 推 tag。
- 依赖 `erix-agent` 是公开包（三份 lockfile 的 `resolved` 全指 `registry.npmjs.org`）⇒ **CI 不需要 NPM_TOKEN**，
  也不需要任何新 secret（GHCR 登录用内置 `GITHUB_TOKEN`）。

---

## 8. 已知坑（本工单验证时实测）

- **runner 的 uid/gid 与开发机不同 ⇒ 属主类断言直接 EPERM**（工单 C2，Actions 首跑
  run 38041183692 / 38041175079：`npm test` 16 项红，错误全部是 `EPERM: operation not permitted, fchown`）。
  - 根因：非特权进程只能把属主改成**自己的 euid**、把属组改成**自己所属的组**（`chown(2)`/`fchown(2)` 硬约束）。
    开发机恰好是 `1000:1000`，与产品默认 `FDE_USER_UID/GID=1000`（`portal/src/config.js:211-212`）撞车 ⇒ 问题被掩盖；
    GitHub runner 的用户不是 `1000:1000` ⇒ `fchown(fd, 1000, 1000)` 当场 EPERM。
    本机实测复现：`docker run --rm -u 1001:1001 … node --test portal/test/git-credential.test.js portal/test/git-cli-config.test.js`
    在 `main` 代码上恰好复现出 CI 里那 16 条（名字逐一对得上）。
  - **口径：测试不得硬编码 uid/gid。**「宿主侧属主」一律取进程自身
    （`const SELF_UID = process.getuid?.() ?? 1000; const SELF_GID = process.getgid?.() ?? 1000;`，
    同时注入 `config.fdeUid/fdeGid` 并用作断言期望值）；只取自身并不是放水——断言仍然是
    「落盘属主 == 配置里给的 fde 属主」，只是那个属主在非特权环境**只能**是自身。
    确实需要「能 chown 到任意属主」才有意义的断言走 `process.getuid() === 0` 的 **root-only 分支**，
    跳过时显式打印原因，**不许用 try/catch 把 EPERM 静默吞掉**。
    语义钉桩见 `portal/test/fsutil-chown.test.js`（自身属主必成功 / 外部 uid 非 root 必 EPERM 且 fail-closed /
    组侧同受限 / root 分支断言真能 chown 到任意外部属主）。
  - **这不是产品缺陷**：生产 portal 以 root 运行（`portal/Dockerfile:37` ⇒ 持 `CAP_CHOWN`），
    `setGitCredential` / `git-cli-config` 里的 `uid: config.fdeUid ?? 1000` 在生产下成立；本轮产品代码零改动。
    （若将来 portal 改成非 root 跑，`setGitCredential` 会真的 EPERM——那是产品口径变更，需单开工单。）
  - **可移植性复跑口径**（不需要真 runner）：
    `docker run --rm -u 1001:1001 -v "$PWD":/work -w /work <node 镜像> npm test`（非 root 分支）
    与 `-u 0:0`（root 分支）各跑一遍，两次都必须 0 失败。
    本开发机上 `unshare -r` / `setpriv --reuid` 都不可用（`kernel.apparmor_restrict_unprivileged_userns=1`
    且没装 `newuidmap`/`newgidmap`）⇒ 用 docker 的 `-u` 代替。
  - ⚠️ 以 root 跑全量单测另有 4 条**既有**用例会红（`offboarding.test.js` 的 F3/D3、`routes.test.js` 的 F3-5/N5）：
    它们靠权限位模拟 EACCES，而 root 无视 0000 权限——与本轮属主口径无关（`main` 基线同样红），
    CI 跑在 uid 1001 上不受影响。
- **同机并发跑测试会假失败**：`runner/test/shell-tools.test.js` 的两条 abort 用例扫 `/proc` 找残留
  `sleep 30.211 / 30.212`（`runner/test/shell-tools.test.js:145-207`）。若同时有另一份测试在跑
  （例：根 `npm test` 与 `cd runner && node --test` 并行），会看到对方的进程 ⇒ 报「abort 后仍有残留命令」。
  CI 里各步是**顺序**执行的，不受影响；本机手工复跑时**别并行**。
- `docs/data/schema.sql` 是**冻结 baseline**：`portal/src/migrate.js:137-138` 对整个文件文本（含注释）算
  sha256 做启动校验 ⇒ 一个字节都别改（改了会让已应用 baseline 的库拒绝启动）。
- `portal/Dockerfile:2` 与本仓 §1 的前端那一步（步骤 ④）同理：镜像构建阶段也**不能**在 builder 里设 `NODE_ENV=production`。
- workflow 里嵌 JS 时**不要**用单引号包裹的多行 `node -e '...'`：JS 里的 `''` 会关掉 shell 引号
  （actionlint/shellcheck SC1078 抓到过），一律走 `cat > "$RUNNER_TEMP/x.mjs" <<'MJS'` 再 `node` 执行。
