#!/usr/bin/env bash
# issue #873②：给真库腿一条**随手能跑**的命令 —— 工具，不是闸。
#
# 为什么要有它：`TEST_DATABASE_URL` 未设 ⇒ **所有真库测试文件整文件 skip**（入口文案由
# `portal/test/pg-fixture.js` 的 `SKIP_WITHOUT_PG` 单点持有，口径见 docs/testing.md §2.2.1）。
# 默认门禁与 CI 都没有 PG ⇒ 这些判据**永远不红也不绿**，漂了很久都没人看见。本脚本把
# 「起一次性 PG → 现取真库文件清单 → 带着 `TEST_DATABASE_URL` 跑 → 删容器」收成一条命令。
#
# **它不是门禁**：CI 里仍然没有 PG ⇒ CI 里这些文件仍然 skip；要不要给 CI 加 service 在 #873 里等拍。
#
# 隔离口径照 docs/testing.md §2.2.1：起的是**一次性** postgres（`--rm`，随机名后缀），
# **绝不指向真库 `station-db`**。
#
# ⚠ **不建自定义网络**（§2.2.1 那条 `docker network create` 在这里不用）：本机网络数一多，
#    `docker network create` 会直接报 `all predefined address pools have been fully subnetted`
#    ——这是现场，不是假想。而这里要的只是「宿主上的 node 连到容器里的 PG」，
#    **发布一个 127.0.0.1 的宿主端口就够了**，不新增网络反而少一个失败面。
#
# 退出码：`node --test` 的退出码**原样传出**（不清零、不改写）。判定只认退出码；
# 摘要行 `# pass` / `# fail` / `# skipped` 只是给人看的（AGENTS.md §4）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 缺省端口取一个不太会被别的会话占着的值（宿主端口占用实况属本机坐标 ⇒ 冷层，见 AGENTS.md §5），
# 可用 --port 覆盖；镜像缺省 postgres:16（与 §2.2.1 同一支），可用 --image 覆盖。
PORT=15599
IMAGE="postgres:16"
KEEP=0

usage() {
  cat <<'EOF'
用法：./scripts/real-db-legs.sh [--port <宿主端口>] [--image <镜像>] [--keep]
  --port <n>   发布到 127.0.0.1:<n>（缺省 15599）
  --image <i>  一次性 PG 用哪个镜像（缺省 postgres:16）
  --keep       跑完不删容器，并打印容器名与连接串（方便反复调）
判定只认退出码；末行 `real-db-legs: rc=<n> files=<n>` 的 rc 就是 node --test 的退出码。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "real-db-legs: 未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PORT" in '' | *[!0-9]*) echo "real-db-legs: --port 要是十进制端口号，拿到的是 '$PORT'" >&2; exit 2 ;; esac
[ -n "$IMAGE" ] || { echo 'real-db-legs: --image 不能为空' >&2; exit 2; }
command -v docker >/dev/null || { echo 'real-db-legs: 这台机器上没有 docker，跑不了真库腿（这正是它默认 skip 的样子）' >&2; exit 1; }
command -v node >/dev/null || { echo 'real-db-legs: 找不到 node' >&2; exit 1; }

C="station-real-db-legs-$$"
DB_URL="postgres://station:test@127.0.0.1:${PORT}/station_test"
LOG="$(mktemp "${TMPDIR:-/tmp}/real-db-legs.XXXXXX")"
RUN_DONE=0

# 清理：只删**自己建的那一个名字**（AGENTS.md §5：禁按前缀批量操作容器）。
# `--rm` 已经保证容器退出即删，这里再兜一次（就绪门失败、被 Ctrl-C 等路径也走得到）。
cleanup() {
  rm -f "$LOG" >/dev/null 2>&1 || true
  if [ "$KEEP" -eq 1 ] && [ "$RUN_DONE" -eq 1 ]; then return 0; fi
  docker rm -f "$C" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "real-db-legs: 起一次性 PG（容器 $C，镜像 $IMAGE，宿主端口 127.0.0.1:${PORT}）"
# 不传 --network：见文件头那条「不建自定义网络」的理由，发布宿主端口就够了。
docker run -d --rm --name "$C" -p "127.0.0.1:${PORT}:5432" \
  -e POSTGRES_USER=station -e POSTGRES_PASSWORD=test -e POSTGRES_DB=station_test \
  "$IMAGE" >/dev/null

# 就绪判定。⚠ 为什么环里不止 `pg_isready` 一条（现验，不是猜）：
#   `pg_isready` 只回答「有没有东西在听」——本机实测它对**不存在的角色**（`-U nosuchuser`）与
#   **不存在的库**（`-d nosuchdb`）**同样返回 0 并输出 "accepting connections"**。
#   只拿它的退出码当就绪门 ⇒ 口令/角色/库配错时这道门照样放行，然后 16 个文件在「连得上但用不了」
#   的实例上集体报错，症状比「就绪门没起来」难懂得多。所以同一环里再补一条 psql：
#   真用 POSTGRES_USER/POSTGRES_DB 连上并取回一行，才算就绪。
READY=0
LAST=''
for _ in $(seq 1 30); do
  set +e
  ping_out="$(docker exec "$C" pg_isready -U station -d station_test -t 3 2>&1)"; ping_rc=$?
  q_out="$(docker exec "$C" psql -U station -d station_test -tAc 'select 1' 2>&1)"; q_rc=$?
  set -e
  LAST="pg_isready rc=${ping_rc}: ${ping_out}
psql rc=${q_rc}: ${q_out}"
  if [ "$ping_rc" -eq 0 ] && [ "$q_rc" -eq 0 ]; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  # 不许静默 0，也不许带着没起来的实例继续往下跑：原始输出打出来再非零退出。
  echo "real-db-legs: 容器 $C 在 30 次探测（每次间隔 1s）内未就绪，原始输出：" >&2
  printf '%s\n' "$LAST" >&2
  echo "real-db-legs: 可以试 --image 换一支镜像，或 --port 换一个没被占的端口（宿主端口占用 ⇒ 冷层）" >&2
  exit 1
fi
echo 'real-db-legs: PG 已就绪（pg_isready + psql select 1 都通）'

# 真库文件清单**现取**：不写死文件名、不写死个数（§2.2.1 已定这条口径：文档里都不写个数，脚本更不能）。
# 新增真库文件接进同一入口（`SKIP_WITHOUT_PG`）就自动被这条命令覆盖。
set +e
FILES_RAW="$(grep -rl SKIP_WITHOUT_PG portal/test test 2>/dev/null | sort -u)"
grep_rc=$?
set -e
if [ "$grep_rc" -ne 0 ] || [ -z "$FILES_RAW" ]; then
  echo 'real-db-legs: 一个真库文件都没找到（grep -rl SKIP_WITHOUT_PG portal/test test 空）' >&2
  echo 'real-db-legs: 扫描面是不是变了？清单是现取的，本脚本不写死文件名/个数。' >&2
  exit 1
fi
mapfile -t FILES <<< "$FILES_RAW"

echo "real-db-legs: 真库清单现取到 ${#FILES[@]} 个文件，开跑"
set +e
TEST_DATABASE_URL="$DB_URL" node --test "${FILES[@]}" > "$LOG" 2>&1
rc=$?
set -e
RUN_DONE=1
cat "$LOG"

if [ "$KEEP" -eq 1 ]; then
  echo "real-db-legs: --keep ⇒ 容器没删：${C}（用完自己删：docker rm -f ${C}）"
  echo "real-db-legs: --keep ⇒ 连接串：${DB_URL}"
fi

echo 'real-db-legs: 摘要行（判定只认退出码，这三行只是给人看的）'
grep -E '^# (pass|fail|skipped)' "$LOG" || echo "(本次输出里没有 # pass/# fail/# skipped 摘要行 ⇒ 更要看 rc)"
echo "real-db-legs: rc=${rc} files=${#FILES[@]}"
exit "$rc"
