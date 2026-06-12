# CS2Ops

轻量级 Counter-Strike 2 RCON 管理后台。

CS2Ops 保留原有 RCON 管理能力，同时新增了更适合异地部署的 HTTP 远程日志模式。它适合下面这种场景：

- CS2 服务器在家里、局域网、Docker、懒猫微服或其他内网设备里运行
- Web 面板部署在 VPS 上
- VPS 不能访问家里机器的 Docker socket
- 但 CS2 可以通过 HTTP 主动把日志推送到 VPS

English documentation: [README.md](README.md)

## 功能概览

- 登录保护的 Web 管理面板
- 登录失败验证码和临时锁定
- RCON 控制台，可以发送任意 CS2 命令，并支持清除当前输出
- 常用 CVAR 快捷预设，包含比赛、模式、经济和练习参数
- 官方地图一键切换
- Workshop 地图 ID 启动
- Workshop 收藏，本地保存在浏览器里
- 玩家卡片列表、搜索、踢出玩家、BOT/HUMAN 标签、SteamID64 复制和 Steam 个人资料跳转
- 从日志和 `status` 中识别 SteamID64，可选通过 Steam Web API 展示真实头像
- 实时日志窗口，基于 Server-Sent Events，并带 1 秒轮询 fallback
- 支持 Docker 本机日志、HTTP 远程日志、禁用日志三种模式
- 中英文界面切换、暗色/浅色主题和更稳定的 dashboard 布局

CS2Ops 不是完整开服面板，也不会接管 CS2 服务器部署、Docker 容器管理或系统编排。

## 工作方式

RCON 管理链路：

```text
浏览器
  -> CS2Ops 面板
  -> RCON
  -> CS2 Dedicated Server
```

Docker 日志模式：

```text
CS2 Docker 容器 -> docker logs -f -> LogHub -> /api/logs/stream -> 浏览器
```

HTTP 远程日志模式：

```text
CS2 Server -> logaddress_add_http -> CS2Ops HTTP Log Receiver -> LogHub -> /api/logs/stream -> 浏览器
```

## 三种日志模式

```env
LOG_SOURCE=docker
```

保留原有 Docker 日志模式。要求 CS2Ops 能访问 CS2 容器所在机器的 Docker。

```env
LOG_SOURCE=http
```

新增 HTTP 远程日志模式。CS2 主动通过 `logaddress_add_http` 把日志 POST 到 CS2Ops。

```env
LOG_SOURCE=none
```

禁用实时日志。RCON、CVAR、地图、Workshop、玩家管理功能仍然可用。

## 安装

```bash
git clone https://github.com/xsgteamx/CS2Ops.git
cd CS2Ops
npm install
cp env.example .env
```

编辑 `.env` 后启动：

```bash
npm start
```

默认访问地址：

```text
http://127.0.0.1:8080
```

## 基础配置

```env
PANEL_PORT=8080
PANEL_BIND_HOST=127.0.0.1
PANEL_BASE_PATH=
PANEL_USER=admin
PANEL_PASS=change_me
PANEL_SESSION_SECRET=change_me_long_random_session_secret
LOGIN_CAPTCHA_ENABLED=true
LOGIN_CAPTCHA_AFTER_FAILURES=2
LOGIN_LOCK_AFTER_FAILURES=10

CS2_HOST=127.0.0.1
CS2_PORT=27015
CS2_RCON_PASSWORD=change_me
```

说明：

- `PANEL_USER` / `PANEL_PASS` 是面板登录账号
- `PANEL_BASE_PATH` 只在面板通过 `/admin` 之类子路径反代时填写，根路径部署保持为空
- `LOGIN_CAPTCHA_*` / `LOGIN_LOCK_*` 用于控制登录失败后的验证码和临时锁定
- `CS2_HOST` / `CS2_PORT` 是 CS2 RCON 地址
- `CS2_RCON_PASSWORD` 只保存在后端 `.env`，不会暴露到前端

可选 Steam 头像配置：

```env
STEAM_WEB_API_KEY=
STEAM_AVATAR_TTL_MS=43200000
```

不配置 `STEAM_WEB_API_KEY` 时，玩家列表仍然正常显示，只使用本地默认头像。Steam Web API 只是头像增强，不是玩家列表的强依赖。

## Docker 本机日志模式

适合 CS2Ops 和 CS2 Docker 容器在同一台机器上的情况。

```env
LOG_SOURCE=docker
DOCKER_CONTAINER=cs2-dedicated
LOG_LINES=200
```

CS2Ops 会启动一个共享的日志读取进程：

```bash
docker logs -f --tail <LOG_LINES> <DOCKER_CONTAINER>
```

不会因为多个浏览器打开面板就启动多个 `docker logs` 进程。

## HTTP 远程日志模式

适合 CS2 服务器在内网、面板在 VPS 的情况。

推荐配置：

```env
LOG_SOURCE=http
LOG_LINES=200
LOG_TTL_MS=3600000

LOG_HTTP_BIND_HOST=0.0.0.0
LOG_HTTP_PORT=27500
LOG_HTTP_PATH=/cs2log
LOG_HTTP_SECRET=change_me_long_random_token
LOG_HTTP_PUBLIC_URL=http://10.6.0.2:27500/cs2log/change_me_long_random_token
LOG_HTTP_MAX_BODY=1mb
LOG_HTTP_MAX_LINES_PER_REQUEST=200
LOG_HTTP_MAX_LINES_PER_WINDOW=200
LOG_HTTP_MAX_LINES_WINDOW_MS=10000
LOG_HTTP_DROP_OLDER_THAN_MS=300000
LOG_HTTP_ALLOW_IPS=
LOG_HTTP_RCON_REGISTER=true
```

`LOG_HTTP_PUBLIC_URL` 是实际写入 CS2 的地址。前端只会显示脱敏后的地址，例如：

```text
http://10.6.0.2:27500/cs2log/********
```

不要把 `LOG_HTTP_SECRET` 暴露到前端、公开仓库或聊天记录里。

HTTP 日志处理行为：

- 每条进入 LogHub 的日志都有递增 `seq` 游标
- 前端在页面可见时约 1 秒刷新一次 HTTP 日志
- 点击“清除”后会记录当前游标，下一轮刷新不会把旧日志重新显示出来
- 新日志仍会正常追加显示
- 刷新状态、执行 RCON 命令、注册/取消 HTTP 日志、地图和 Workshop 操作完成后都会立即尝试刷新 HTTP 日志
- HTTP receiver 会过滤 cvar dump、敏感字段、过旧日志和超出限流窗口的日志

### HTTP Receiver 健康检查

```bash
curl http://127.0.0.1:27500/healthz
```

### 本机测试日志接收

```bash
curl -v -X POST \
  --data-binary 'hello from cs2' \
  http://127.0.0.1:27500/cs2log/<secret>
```

预期：

- HTTP 返回 `204`
- 面板日志窗口出现测试日志
- `/api/logs/status` 的 `lastReceivedAt` 更新时间

### 从 CS2 所在机器测试

如果 CS2 所在机器可以访问 VPS 的 WireGuard 地址或公网地址，可以测试：

```bash
curl -v -X POST \
  --data-binary 'hello from lan cs2' \
  http://10.6.0.2:27500/cs2log/<secret>
```

能在面板看到日志，说明网络链路可用。

## 通过 RCON 注册 HTTP 日志

当：

```env
LOG_SOURCE=http
LOG_HTTP_RCON_REGISTER=true
```

可以在面板的 HTTP 远程日志区域点击“启用推送”。

后端会通过 RCON 执行：

```text
log on
logaddress_delall_http
logaddress_add_http "<LOG_HTTP_PUBLIC_URL>"
mp_logdetail 3
logaddress_list_http
```

说明：

- `log on` 会开启 CS2 日志输出
- `logaddress_delall_http` 用于清理旧 HTTP log 地址，避免重复注册
- `logaddress_add_http` 会写入 `.env` 中的 `LOG_HTTP_PUBLIC_URL`
- `mp_logdetail 3` 是 best-effort，失败只作为 warning
- 返回给前端的内容会做 secret 脱敏

点击“取消推送”会执行：

```text
logaddress_delall_http
logaddress_list_http
```

不会执行 `log off`，避免影响服务器本地日志。

## 玩家列表

玩家列表现在优先使用 RCON `status` 输出作为展示来源，并结合 `users` 和最近日志补充 Steam 信息。

规则说明：

- BOT 判断只看 `status` 里明确的 `BOT` 标记或后端明确字段，不再靠玩家名字匹配
- 真人玩家如果能拿到 SteamID64，会显示复制按钮和 Steam 个人资料跳转
- 没有 SteamID64 时显示“未知 / Unknown”，不会显示奇怪的 `-`
- BOT 不会显示 Steam 个人资料跳转
- 头像优先使用后端返回的 `avatar` 字段
- 没有真实头像或头像加载失败时，自动显示本地默认头像
- 配置 `STEAM_WEB_API_KEY` 后，后端会尝试通过 Steam Web API 补充真人玩家头像，并使用缓存降低请求频率

## 禁用日志模式

```env
LOG_SOURCE=none
```

这个模式不会启动 Docker 日志读取，也不会启动 HTTP receiver。

适合只想使用 RCON 管理功能，或者临时关闭日志功能时使用。

## 安全建议

- `.env` 不要提交到 Git
- 不要把 `CS2_RCON_PASSWORD` 暴露给前端
- 不要把 `LOG_HTTP_SECRET` 暴露给前端
- HTTP receiver 不走 Basic Auth，因为 CS2 的 `logaddress_add_http` 不能携带 Basic Auth
- HTTP receiver 依赖 URL secret、body limit、可选 IP allowlist、以及防火墙
- 如果走公网，强烈建议配置 `LOG_HTTP_ALLOW_IPS`
- 面板公开访问时建议放在 HTTPS 反向代理后面
- 推荐 `PANEL_BIND_HOST=127.0.0.1`，由 Nginx / Apache / Caddy 对外代理

## 反向代理注意事项

CS2Ops 默认监听：

```text
PANEL_BIND_HOST:PANEL_PORT
```

如果用 Nginx、Apache 或 Caddy 反向代理，请确保以下路径正常转发：

```text
/
/login
/logout
/api/*
/api/logs/stream
```

`/api/logs/stream` 是 SSE 实时日志接口，反向代理不要缓冲它。

如果部署在 `/admin/` 这种子路径下，需要确保静态资源、API、登录、登出、SSE 都按照同一个前缀正确转发。

同时需要在 `.env` 设置：

```env
PANEL_BASE_PATH=/admin
```

## systemd 示例

HTTP 模式或 none 模式不需要 Docker 依赖：

```ini
[Unit]
Description=CS2Ops Web RCON Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/CS2Ops
EnvironmentFile=/opt/CS2Ops/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=3
User=cs2ops

[Install]
WantedBy=multi-user.target
```

如果使用 `LOG_SOURCE=docker`，运行用户必须有读取 Docker logs 的权限。

## 常用 API

面板：

```text
GET  /
GET  /login
GET  /login/captcha-status
GET  /login/captcha
POST /login
POST /logout
```

RCON 和管理：

```text
POST /api/command
POST /api/cvar
GET  /api/maps
POST /api/map/standard
POST /api/map/workshop
GET  /api/players
GET  /api/autocomplete
```

日志：

```text
GET  /api/logs/stream
GET  /api/logs/status
GET  /api/logs/recent
POST /api/logs/register-http
POST /api/logs/unregister-http
POST /api/logs/test
POST /api/logs/clear
```

HTTP receiver：

```text
GET  /healthz
POST <LOG_HTTP_PATH>/<LOG_HTTP_SECRET>
```

## 自测命令

```bash
node --check server.js
node --check public/app.js
node --check src/steamIdTracker.js
npm audit
npm start
```

建议分别测试：

- `LOG_SOURCE=none`：面板启动，RCON 功能正常，不依赖日志
- `LOG_SOURCE=http`：HTTP receiver 启动，curl POST 能进面板
- `LOG_SOURCE=docker`：本机 Docker 容器日志能进入面板

## 许可证

MIT。
