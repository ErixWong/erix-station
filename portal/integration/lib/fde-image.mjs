// e2e 镜像「构建 + 清理」公共口径（issue #178，所有 portal/integration/*.mjs 共用）。
//
// 背景（真机实证，勿删）：
//  1) `runner/Dockerfile` 有一层 RUN 从 github.com / dl.gitea.io / gitlab.com 直连下载 gh/tea/glab
//     （curl --retry 5）。本机直连被墙 → 必须经 v2ray 代理构建。代理在容器 172.20.0.35:19001，
//     构建容器只有 `--network=host` 才能直达（同机 bridge 之间被 DOCKER-ISOLATION 挡）。
//     故构建时显式传 HTTP_PROXY/HTTPS_PROXY/NO_PROXY —— 这三个是 Docker 的**预定义 build arg**，
//     RUN 里无需 `ARG` 声明即可生效（因此**不用改 Dockerfile**）；proxy 非空时额外加 `--network=host`。
//  2) build args 参与 Docker 缓存键：三个 arg 一律**显式传**（未设置时传空串），避免「有时带有时不带」
//     导致缓存反复失效、每次都重跑下载层。
//  3) `execSync` 默认 `stdio:'pipe'` 会把子进程输出缓冲到结束才返回 → 构建挂死时**零输出**，
//     表现为「跑半小时什么都没发生」。故构建走 `stdio:['pipe','inherit','inherit']` 流式输出。
//  4) 镜像名必须由 env 派生（`FDE_IMAGE` / `STATION_PORTAL_IMAGE`）。**e2e 绝不删除默认共享 tag**
//     （`erix-station/fde:local` / `erix-station/portal:local`）——实证事故：脚本 `rmi -f` 掉共享
//     fde 镜像后，共享栈 provision FDE 报 `No such image`。隔离栈有自己的派生 tag；`docker build`
//     与 `compose up -d --build` 会按 build context 变更自动失效缓存，**无需靠删镜像强制重建**。
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const DEFAULT_FDE_IMAGE = 'erix-station/fde:local';
export const DEFAULT_PORTAL_IMAGE = 'erix-station/portal:local';

const PROXY_BUILD_ARGS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'];

/** 取 proxy 值（大写优先，兼容小写 env）；未设置 → 空串。 */
function proxyValue(name) {
  return process.env[name] ?? process.env[name.toLowerCase()] ?? '';
}

/** 组装 `docker build -t <image> runner/` 命令（含 proxy build args、按需 `--network=host`）。 */
export function fdeBuildCommand(image) {
  const proxies = PROXY_BUILD_ARGS.map((name) => [name, proxyValue(name)]);
  const parts = ['build', '-t', image, 'runner/'];
  // 仅当 HTTP(S)_PROXY 非空时才需要 host 网络直达代理（NO_PROXY 单独非空不构成理由）。
  if (proxies.some(([name, value]) => value && name !== 'NO_PROXY')) parts.push('--network=host');
  for (const [name, value] of proxies) parts.push(`--build-arg ${name}=${JSON.stringify(value)}`);
  return parts.join(' ');
}

/**
 * 构建 FDE 镜像：流式输出（构建卡住一眼可见）+ proxy build args（见文件头）。
 * @param {string} image 目标 tag（必须由 env 派生，勿用默认共享 tag 做隔离构建）
 */
export function buildFdeImage(image, { repoRoot = REPO_ROOT, log = console.log, exec = execSync } = {}) {
  const command = fdeBuildCommand(image);
  const hostNet = command.includes('--network=host') ? '（--network=host）' : '';
  log(`[e2e] 构建 FDE 镜像 ${image}${hostNet} …（冷构建需联网下载 gh/tea/glab，须先导出 HTTP_PROXY/HTTPS_PROXY，见文件头）`);
  exec(`sg docker -c ${JSON.stringify(`docker ${command}`)}`, {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: repoRoot,
  });
  log(`[e2e] FDE 镜像 ${image} 构建完成`);
}
