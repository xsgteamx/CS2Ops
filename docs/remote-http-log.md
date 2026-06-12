# CS2 HTTP Remote Log

## 适用场景

CS2 服务器运行在局域网、Docker 或懒猫微服中，CS2Ops 面板部署在 VPS 上。VPS 不能访问 CS2 所在机器的 Docker socket，因此不能依赖 `docker logs`，但 CS2 可以访问 VPS 的某个 HTTP 端口。

链路：

```text
CS2 Server -> logaddress_add_http -> CS2Ops HTTP Log Receiver -> LogHub -> /api/logs/stream
```

## 推荐配置

```env
LOG_SOURCE=http
LOG_LINES=200
LOG_TTL_MS=3600000

LOG_HTTP_BIND_HOST=0.0.0.0
LOG_HTTP_PORT=27500
LOG_HTTP_PATH=/cs2log
LOG_HTTP_SECRET=请生成长随机字符串
LOG_HTTP_PUBLIC_URL=http://10.6.0.2:27500/cs2log/请生成同一个长随机字符串
LOG_HTTP_MAX_BODY=1mb
LOG_HTTP_MAX_LINES_PER_REQUEST=200
LOG_HTTP_MAX_LINES_PER_WINDOW=200
LOG_HTTP_MAX_LINES_WINDOW_MS=10000
LOG_HTTP_DROP_OLDER_THAN_MS=300000
LOG_HTTP_ALLOW_IPS=
LOG_HTTP_RCON_REGISTER=true
```

`LOG_HTTP_PUBLIC_URL` 是写入 CS2 的地址。前端只会显示脱敏后的地址，例如：

```text
http://10.6.0.2:27500/cs2log/********
```

## 防火墙

如果走 WireGuard，建议只允许 WG 网段访问 `27500/tcp`。

如果走公网 IP，需要放行云安全组和系统防火墙的 `27500/tcp`。强烈建议配置 `LOG_HTTP_ALLOW_IPS` 限制来源 IP。

## 通过面板注册

当 `LOG_SOURCE=http` 且 `LOG_HTTP_RCON_REGISTER=true` 时，在日志区域点击“启用推送”。后端会通过 RCON 执行：

```text
log on
logaddress_delall_http
logaddress_add_http "<LOG_HTTP_PUBLIC_URL>"
mp_logdetail 3
logaddress_list_http
```

`mp_logdetail 3` 是 best-effort，失败只作为 warning，不会让整体注册失败。

点击“取消推送”会执行：

```text
logaddress_delall_http
logaddress_list_http
```

不会执行 `log off`，避免影响服务器本地日志。

## 手动 RCON 命令

也可以手动执行：

```text
log on
logaddress_delall_http
logaddress_add_http "http://10.6.0.2:27500/cs2log/<secret>"
mp_logdetail 3
logaddress_list_http
```

## 验证日志到达

在 VPS 上启动 CS2Ops 后，可以本机测试：

```bash
curl -v -X POST \
  --data-binary '"TestPlayer<65280><[U:1:141511211]><>" STEAM USERID validated' \
  http://127.0.0.1:27500/cs2log/<secret>
```

从局域网 CS2 所在机器测试：

```bash
curl -v -X POST \
  --data-binary 'hello from lan cs2' \
  http://10.6.0.2:27500/cs2log/<secret>
```

预期：

```text
HTTP 返回 204
面板日志区域出现测试日志
/api/logs/status 的 lastReceivedAt 更新
```

错误 secret 预期返回 `404`，且不会写入 LogHub。

## 三种日志模式

```env
LOG_SOURCE=docker
```

保留原 Docker 模式，通过单个 `docker logs -f --tail <LOG_LINES> <DOCKER_CONTAINER>` follower 写入 LogHub。

```env
LOG_SOURCE=http
```

启动 HTTP receiver，不访问 Docker。

```env
LOG_SOURCE=none
```

不启动 Docker follower，也不启动 HTTP receiver。RCON 主功能仍可使用，日志页显示“日志已禁用”。
