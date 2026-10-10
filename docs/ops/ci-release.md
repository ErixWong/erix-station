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

**门禁四步（顺序执行，任一失败即红；`ci.yml` 步骤 ①–④）**

1. `node --check` 扫全部 git 跟踪的 `*.js` / `*.mjs`（当前 136 个文件；仓库 `type: module`，
   `node --check` 会按 `package.json` 的 type 解析，ESM 文件实测 rc=0）。
2. 根 `npm ci` + `npm test` → **850 项 / 849 通过 / 0 失败 / 1 跳过**（基线，2026-10-10 本机复现）。
   ⚠️ 根 `node --test` 的发现规则会把 `runner/test/*.test.js` 一起收进来 ⇒ **850 里已含 runner 的 198 项**。
3. `cd runner && npm ci && node --test` → **198/198**。口径见 `AGENTS.md` §4：
   **`node --test runner/test/`（目录当参数）在本机 Node 22/24 是坏的**（把目录当模块加载 → `Cannot find module`），别用。
4. `cd portal/frontend && NODE_ENV=development npm ci && npm run typecheck && npm test` → typecheck 干净 + **23 文件 / 329 通过**。
   `NODE_ENV=development` 是**必需**的：devDependencies（vite/tailwind/vitest）在 `NODE_ENV=production` 下会被 `npm ci` 跳过。

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
2. **固定 IPAM 池**：`assertIsolatedEnvironment()` 硬断言 `FDE_IPAM_POOLS` 恰为 `['10.201.0.0/16']`
   （`wp5-e2e.mjs:65-66`、`wp6-llm-e2e.mjs:73-74`），还断言一堆隔离栈专属 env（容器名、端口、
   `STATION_DB_DIR` 必须在临时目录且**不存在**）；GitHub runner 上没有这套网络前提。
3. 需要**泛域名解析 + Tailscale**（`*.fde.erix.vip` → `100.100.0.3`）与宿主 Traefik host 网络。
4. 分钟成本：一条 e2e 链路跑下来在 CI 里要占十几分钟，Free 额度撑不住（§4）。

**口径**：e2e 由**主 agent 在部署机上、本机隔离栈**跑（`wp3b` / `wp5` / `wp6`），**部署前**执行；
CI 只保证「语法 + 单测 + 类型 + 镜像能构建出来」。

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

- **同机并发跑测试会假失败**：`runner/test/shell-tools.test.js` 的两条 abort 用例扫 `/proc` 找残留
  `sleep 30.211 / 30.212`（`runner/test/shell-tools.test.js:145-207`）。若同时有另一份测试在跑
  （例：根 `npm test` 与 `cd runner && node --test` 并行），会看到对方的进程 ⇒ 报「abort 后仍有残留命令」。
  CI 里四步是**顺序**执行的，不受影响；本机手工复跑时**别并行**。
- `docs/data/schema.sql` 是**冻结 baseline**：`portal/src/migrate.js:137-138` 对整个文件文本（含注释）算
  sha256 做启动校验 ⇒ 一个字节都别改（改了会让已应用 baseline 的库拒绝启动）。
- `portal/Dockerfile:2` 与本仓 §1 的第 4 步同理：镜像构建阶段也**不能**在 builder 里设 `NODE_ENV=production`。
- workflow 里嵌 JS 时**不要**用单引号包裹的多行 `node -e '...'`：JS 里的 `''` 会关掉 shell 引号
  （actionlint/shellcheck SC1078 抓到过），一律走 `cat > "$RUNNER_TEMP/x.mjs" <<'MJS'` 再 `node` 执行。
