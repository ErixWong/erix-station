#!/usr/bin/env bash
# 构建 kkFileView 5.0.3 镜像（issue #366）——官方 Hub 镜像停在 4.1.0（无 file:// 本地
# 协议支持，ro 挂载预览设计的前提），上游 5.x 又没发布 Docker 镜像，故自建。
#
# 用法（任意机器，需 docker + 外网/代理）：
#   ./build-image.sh              # 全量：取源码 → maven 打包 → base 镜像 → 应用镜像
#   ./build-image.sh --dist-only  # 跳过 maven，用已存在的 dist/（CI 产物解包放这里）
#
# 产物：erix-station/kkfileview:5.0.3（compose 里 KKFILEVIEW_IMAGE 指它，
# 或 push 到 GHCR 后按 digest 钉死）。
set -euo pipefail
cd "$(dirname "$0")"
VER=5.0.3
TAG=erix-station/kkfileview:${VER}
BASE_TAG=erix-station/kkfileview-base:${VER}
SRC=/tmp/kkbuild/kkFileView-${VER}
DIST_DIR=dist

if [ "${1:-}" != "--dist-only" ]; then
  # 源码：codeload tarball（支持断点续传；浅克隆在大仓 + 抖动链路上反而脆）
  if [ ! -f /tmp/kk${VER//./}.tar.gz ] || ! gzip -t /tmp/kk${VER//./}.tar.gz 2>/dev/null; then
    mkdir -p /tmp/kkbuild
    curl -fL -C - --retry 5 --retry-delay 3 -o /tmp/kk${VER//./}.tar.gz \
      "https://codeload.github.com/kekingcn/kkFileView/tar.gz/refs/tags/v${VER}"
    rm -rf "$SRC" && tar -xzf /tmp/kk${VER//./}.tar.gz -C /tmp/kkbuild
  fi
  # 打包（依赖缓存挂 /tmp/kkm2，重跑快）；产出 server/target/kkFileView-${VER}.tar.gz（assembly dist）。
  # ⚠ 源码必须 **cp 进容器本地再打包**，不能挂载直打：本机 uid/gid 是 AD 大数（gid>2097151），
  # maven-assembly 往 tar 里写挂载文件的属主会报「group id is too big」（POSIX tar 字段上限），
  # 容器内本地文件是 uid/gid 0 就没这问题——真机踩过（v5.0.3 首建）。
  mkdir -p /tmp/kkm2 /tmp/kkdist
  docker run --rm -v "$SRC":/src:ro -v /tmp/kkm2:/root/.m2 -v /tmp/kkdist:/out ubuntu:noble \
    bash -c 'mkdir -p /build-kk && cp -r /src/. /build-kk/ && cd /build-kk && mvn -B -q -DskipTests -pl server -am package && cp server/target/kkFileView-'"${VER}"'.tar.gz /out/'
  rm -rf "$DIST_DIR" && mkdir -p "$DIST_DIR" && \
    tar -xzf /tmp/kkdist/kkFileView-${VER}.tar.gz -C "$DIST_DIR"
fi

[ -d "$DIST_DIR/kkFileView-${VER}" ] || { echo "缺 $DIST_DIR/kkFileView-${VER}（先跑非 --dist-only，或把 release tar 解到这里）"; exit 1; }

docker build -f Dockerfile.base -t "$BASE_TAG" .
docker build -f Dockerfile --build-arg BASE_IMAGE="$BASE_TAG" -t "$TAG" .
echo "OK: $TAG"
