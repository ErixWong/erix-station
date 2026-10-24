# kkFileView 5.0.3 应用镜像（issue #366）
#
# 构建两步（都在本机，产物进 compose 的 KKFILEVIEW_IMAGE）：
#   1) 打包：docker run --rm -v <repo>/deploy/kkfileview/src-cache:/src -w /src \
#        -e MAVEN_OPTS="-Dmaven.repo.local=/src/.m2" \
#        maven:3.9-eclipse-temurin-21 mvn -q -DskipTests -pl server -am package
#      （或直接用 CI 产物：解压 kkFileView-5.0.3.tar.gz 到 deploy/kkfileview/dist/）
#   2) 镜像：docker build -f deploy/kkfileview/Dockerfile \
#        --build-arg BASE_IMAGE=erix-station/kkfileview-base:5.0.3 \
#        -t erix-station/kkfileview:5.0.3 deploy/kkfileview
#
# dist/ 期望内容 = 上游 release tar 解出的 kkFileView-5.0.3/（bin/ config/ lib/ static/ web/）。
# 运行配置全部走 KK_* 环境变量（5.x 的 config/application.properties 是 ${KK_X:default}
# 占位符模板，见 docker-compose.yml station-kkfileview 段），无需挂载配置文件。
ARG BASE_IMAGE=erix-station/kkfileview-base:5.0.3
FROM ${BASE_IMAGE}

COPY dist/kkFileView-5.0.3 /opt/kkFileView-5.0.3

# 非 root（uid/gid 1000，对齐 userspace 属主）：应用目录内可能的写面（logs/work）预先放开，
# 运行期真正的产物/日志面在 tmpfs（compose），这里只是防启动即挂的兑底。
RUN mkdir -p /opt/kkFileView-5.0.3/log /opt/kkFileView-5.0.3/logs && \
    chmod -R a+w /opt/kkFileView-5.0.3/log /opt/kkFileView-5.0.3/logs

# 上游同款入口：显式指定外置配置（占位符从 env 解析）。
ENV KKFILEVIEW_BIN_FOLDER=/opt/kkFileView-5.0.3/bin
EXPOSE 8012
ENTRYPOINT ["java","-Dfile.encoding=UTF-8",\
  "-Dspring.config.location=/opt/kkFileView-5.0.3/config/application.properties",\
  "-jar","/opt/kkFileView-5.0.3/bin/kkFileView-5.0.3.jar"]
