// issue #404 结案：容器里跑的「版本」必须是**构建产物**，不是运维旋钮。
//
// 为什么在这儿：`containers.agent_version` 曾长期写着一个 10-25 之后没人再动的 `.env` 静态值
// （`FDE_AGENT_VERSION=0.1.32-088e41e`），而容器实际早已换过两个版本；同时 agentd 上报的
// `ERIX_AGENT_VERSION` **从来没被任何地方设过**，于是落到 `'0.1.0'` 这个兜底常量——账上、上报、
// 真相三方各说各话。根因不是"忘了同步"，是**版本有两个来源**（构建 + 一个手工 env），而手工那个
// 没人负责、也没人检查。
//
// 现在的唯一真相：镜像构建期写进 `/opt/erix/build-info.json`（见 Dockerfile），运行时只读不猜。
// 优先级三级，且**绝不抛错**——这在 agentd 的心跳热路径上，读不到版本不能让心跳死：
//   ① `ERIX_AGENT_VERSION`：显式 override，默认不设。设了就是"我知道我在盖什么"（测试/临时钉版本）。
//   ② `build-info.json`：镜像里的构建产物（station_version / engine_version / revision）。
//   ③ 本地 `package.json`：仓库里直接跑 agentd（dev）时的退路；拿不到就 `unknown`。
//
// ⚠ 没有 `'0.1.0'` 这种兜底版本号了：**未知就写 unknown**。一个看起来合法的假值比空值毒——
// 它这两周就是靠 `0.1.0` / `0.1.32-088e41e` 两个"合法样子"骗过了所有看的人。
//
// 契约口径：心跳 body 里 `agent_version` = **erix-agent（引擎）版本**（`docs/api/portal.md` U4 就这么
// 定义的），runner 自己的版本另放 `runner_version`，构建 revision 放 `build_revision`。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNKNOWN = 'unknown';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readVersion(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof raw?.version === 'string' && raw.version.trim() !== '' ? raw.version.trim() : null;
  } catch {
    return null; // 缺文件 / 坏 JSON / 没 version 字段，一律走下一级
  }
}

/**
 * 读构建期烘进去的版本信息。任何一步失败都只降级，不抛错。
 * @param {{env?: Record<string,string|undefined>, buildInfoPath?: string, packageDir?: string}} [opts]
 * @returns {{agentVersion: string, runnerVersion: string, revision: string, builtAt: string, source: 'env'|'build-info'|'package'|'unknown'}}
 */
export function readBuildInfo({ env = process.env, buildInfoPath, packageDir } = {}) {
  const out = { agentVersion: UNKNOWN, runnerVersion: UNKNOWN, revision: UNKNOWN, builtAt: UNKNOWN, source: 'unknown' };
  const s = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

  // ② build-info.json（镜像里的构建产物）
  const infoPath = s(buildInfoPath) ?? s(env.ERIX_BUILD_INFO_PATH) ?? '/opt/erix/build-info.json';
  try {
    const j = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const engine = s(j.engine_version);
    const station = s(j.station_version);
    if (engine || station) {
      out.agentVersion = engine ?? UNKNOWN;
      out.runnerVersion = station ?? UNKNOWN;
      out.revision = s(j.revision) ?? UNKNOWN;
      out.builtAt = s(j.built_at) ?? UNKNOWN;
      out.source = 'build-info';
    }
  } catch { /* 落下一级 */ }

  // ③ dev 退路：仓库里直接跑（没有 /opt/erix），runner 版本取本地 package.json；
  // 引擎版本从 node_modules 里的文件**直接读**——不能用 `require('erix-agent/package.json')`，
  // 它的 exports 只开了 `.` / `./tools` / `./contract-tests`，裸 spec 那条路会 ERR_PACKAGE_PATH_NOT_EXPORTED。
  if (out.source === 'unknown') {
    const root = packageDir ?? path.resolve(HERE, '..');
    const runnerVersion = readVersion(path.join(root, 'package.json'));
    if (runnerVersion) {
      out.runnerVersion = runnerVersion;
      const engineVersion = readVersion(path.join(root, 'node_modules', 'erix-agent', 'package.json'));
      if (engineVersion) out.agentVersion = engineVersion;
      out.source = 'package';
    }
  }

  // ① 显式 override 最高
  const override = s(env.ERIX_AGENT_VERSION);
  if (override) {
    out.agentVersion = override;
    out.source = 'env';
  }
  return out;
}
