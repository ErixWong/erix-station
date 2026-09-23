# portal/static/vendor — 前端静态依赖（本地 vendor，容器自包含，不依赖 CDN）

| 包 | 版本 | 来源 | 校验 |
| --- | --- | --- | --- |
| bootstrap | 5.3.3 | <https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/> | 官方 dist：`css/bootstrap.min.css(+map)`、`js/bootstrap.bundle.min.js(+map)` |
| bootstrap-icons | 1.11.3 | <https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/> | `bootstrap-icons.min.css` + `fonts/bootstrap-icons.woff2/.woff`（css 内 url 引用的全部字体） |

- 升级：替换对应文件并保持相对路径不变（icons css 内字体路径为 `./fonts/`）。
- 页面引用路径：`/vendor/bootstrap/css/bootstrap.min.css`、`/vendor/bootstrap/js/bootstrap.bundle.min.js`（页面底部 defer 前引入）、`/vendor/bootstrap-icons/font/bootstrap-icons.min.css`。
- 下载时间：2026-09-23；如需核对，jsdelivr 文件与官方 GitHub release（twbs/bootstrap v5.3.3 / twbs/icons v1.11.3）逐字节一致。
