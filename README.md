# Stronghold Protocol Docker 自动构建

为 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 提供独立的 Docker 构建仓库。游戏源码在 Actions 运行时从上游获取，本仓库维护 Dockerfile、GitHub Actions 和部署配置，不需要手动同步游戏代码。

默认跟踪上游 `master`，发布到 **GitHub Container Registry (GHCR)**：

```text
ghcr.io/<你的 GitHub 用户名或组织>/<本仓库名>:latest
```

镜像名称全部小写。支持 `linux/amd64` 与 `linux/arm64`，使用 Node.js 22 Alpine，以非 root 用户运行。

## 1. 启用自动构建

1. 在 GitHub 创建仓库，例如 `Stronghold-Protocol-Action`，把本目录中的文件提交并推送到默认分支（通常为 `main`）。不要提交 `.cache/` 或下载的上游源码。
2. 打开仓库 **Actions → Build and publish Docker image → Run workflow**，选择默认分支运行。首次推送构建文件也会自动触发。
3. 无需新增 Secrets：发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，工作流声明了 `contents: read` 与 `packages: write`。组织策略需允许这些操作；出现 `permission_denied: write_package` 时检查组织策略及同名 Package 的 Actions 访问权限。
4. 构建成功后，在仓库 **Packages** 中查看镜像，Actions 运行摘要中有完整镜像名称、上游提交和镜像 digest。
5. GHCR 新建包通常默认为私有。若希望免登录拉取，可在 Package settings 中把可见性改为 Public；保持私有时，部署主机需要先使用具有 `read:packages` 权限的 Personal access token (classic) 登录 `ghcr.io`。

官方参考：[GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 访问与可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### 触发规则

| 事件 | 行为 |
| --- | --- |
| 默认分支推送构建相关文件 | 构建、验证两个架构并发布 |
| 每日定时任务 | 北京时间 11:23 左右重新构建跟踪的上游版本并发布 |
| 手动运行 | 可指定上游分支、Tag 或完整提交 SHA，选择是否下载素材 |
| Pull Request | 在原生 amd64 / arm64 runner 上构建并验证精简镜像，不登录、不发布 |
| 非默认分支推送 | 仅检查工作流、标签规则和 Compose 配置 |
| 在非默认分支手动运行 | 构建验证，但不发布 |

定时任务只在默认分支运行，GitHub 可能延迟调度。它每天重建，不检查上游是否有新提交；这样也能更新 Node 基础镜像。上游推送不会直接触发本仓库，最长约一天后跟进。公开仓库长期无活动时 GitHub 可能停用定时任务，可在 Actions 页面重新启用。

### 可选配置

在 **Settings → Secrets and variables → Actions → Variables** 添加：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_REF` | `master` | 自动构建跟踪的上游分支、Tag 或完整 SHA |
| `FETCH_ASSETS` | `1` | 自动构建是否下载素材；`0` 为精简镜像，只接受 `0` 或 `1` |
| `NODE_IMAGE` | `node:22-alpine` | Node 基础镜像，必须支持两个架构且兼容上游依赖 |

手动运行时，留空 `upstream_ref` 使用 `UPSTREAM_REF`；`include_assets` 复选框覆盖 `FETCH_ASSETS`，默认勾选。

### 标签规则

| 构建内容 | 标签 |
| --- | --- |
| 跟踪版本，含公开素材 | `latest`、`sha-<上游完整 SHA>` |
| 跟踪版本，不下载素材 | `latest-lite`、`sha-<上游完整 SHA>-lite` |
| 手动指定其他版本 | 仅对应的 `sha-…` 标签，不覆盖 `latest` / `latest-lite` |

`latest` 表示跟踪分支的最新构建，并不表示上游最新 Release。SHA 标签标识游戏源码版本；相同源码重新构建时，基础镜像、素材和构建配置仍可能变化。严格锁定部署应使用运行摘要中的 `ghcr.io/…@sha256:…`。

## 2. Docker Compose 部署

### 单文件部署（无需 `.env`）

在一个空目录中创建 `compose.yaml`，复制以下完整配置即可使用本仓库的镜像，无需下载仓库或创建 `.env` 文件：

环境变量含义参考[上游「端口与配置」说明](https://github.com/sganggs/Stronghold-Protocol#端口与配置)，下面的注释补充了容器端口与监听地址的配置方式。

```yaml
services:
  stronghold:
    image: ghcr.io/vincywindy/stronghold-protocol-action:latest
    restart: unless-stopped
    init: true
    ports:
      - "3000:3000"
    environment:
      # 容器内服务端口，默认 3000；须与 ports 映射右侧的端口一致。
      PORT: "3000"
      # 容器内监听地址，默认 0.0.0.0（所有网卡），供 Docker 端口映射访问。
      # 127.0.0.1 仅监听容器自身回环地址；限制宿主机访问范围应修改 ports。
      HOST: "0.0.0.0"
      # 战斗计算位置：client（默认）在玩家浏览器计算，服务器负载较低；
      # server 改由服务器计算并推送战斗过程。
      SP_COMBAT: "client"
      # 服务器复算客户端战斗结果：off（默认）关闭；sample 约抽查 1/8；
      # all 全部复算，CPU 开销更高。
      SP_VERIFY: "off"
      # 是否采信 X-Forwarded-For 等代理转发头：auto（默认）仅信任本机/内网来源；
      # "1" 信任所有来源；"0" 忽略转发头。数字值也需保留引号。
      TRUST_PROXY: "auto"
    # 对局保存在内存中，挂载数据卷也无法在重启后恢复对局。
    stop_grace_period: 30s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

在该目录执行：

```bash
docker compose pull
docker compose up -d
```

访问 `http://<服务器地址>:3000`。要使用其他宿主机端口，例如 8080，将 `ports` 改为 `"8080:3000"`，容器内的 `PORT` 保持 `"3000"`。其他配置直接修改上述 YAML 即可。

### 使用仓库配置与 `.env`

复制 `.env.example` 为 `.env`，将 `IMAGE` 修改为你的实际镜像地址：

```dotenv
IMAGE=ghcr.io/your-name/stronghold-protocol-action:latest
HTTP_PORT=3000
```

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f
```

访问 `http://<服务器地址>:3000`。镜像内置 `/healthz` 健康检查；联机 WebSocket 路径为 `/ws`，使用反向代理时须转发 WebSocket 升级，并将游戏部署在域名根路径。

使用 Docker 命令直接启动：

```bash
docker run -d --name stronghold --init --restart unless-stopped \
  -p 3000:3000 ghcr.io/your-name/stronghold-protocol-action:latest
```

更新运行中的服务：

```bash
docker compose pull
docker compose up -d
```

游戏房间和对局保存在内存中，更新或重启会结束当前对局；无需数据库或存档卷。镜像发布不会自动更新你已经运行的容器。

使用 `.env` 方式时，`HTTP_PORT` 改宿主机端口，容器端口固定为 3000。`BIND_ADDRESS=127.0.0.1` 可用于同机反向代理；默认 `0.0.0.0` 允许从局域网访问。其余变量见 `.env.example` 和[上游部署文档](https://github.com/sganggs/Stronghold-Protocol/blob/master/docs/DEPLOY.md)。

## 3. 素材范围

默认在构建阶段执行上游 `tools/fetch-assets.mjs`，下载公开镜像提供的美术、音频和字体。素材下载脚本报错时立即停止构建，不发布残缺镜像。首次构建需要下载数百 MB，后续使用 GitHub Actions 构建缓存。

这**不等同于上游 Release 完整整合包**：官方 3D 棋盘等本地客户端提取素材不在该下载范围中。需要时，从与代码相同版本的上游完整包取得 `public/assets/local/` 和 `data/local-assets.json`，通过 Compose override 分别只读挂载到 `/app/public/assets/local/` 和 `/app/data/local-assets.json`。不要用空目录覆盖镜像中的整个 `/app/public/assets`。

精简镜像不自动下载素材，直接运行会使用缺图占位或回退效果。可从同一版本已完成上游 setup 的目录只读挂载 `public/assets`、`public/fonts`、`data/assets.json`，对应到镜像的 `/app/` 下相同路径。

本项目沿用上游运行方式，保留镜像内 `/app/LICENSE`、`/app/NOTICE.md`、`/app/THIRD-PARTY-NOTICES.md`。上游代码声明为 GPL-3.0-or-later；游戏素材和数据不属于该代码许可证的授权范围，遵循[上游声明](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)，仅用于个人非商业学习与娱乐。

## 4. 本地构建与验证

需要 Git、Docker Engine / Docker Desktop 与 Buildx。仓库根目录作为命令运行目录，上游目录作为 Docker 构建上下文：

```bash
git clone --depth 1 https://github.com/sganggs/Stronghold-Protocol.git upstream
docker build -f Dockerfile --build-arg FETCH_ASSETS=1 -t stronghold-protocol:local ./upstream
docker run --rm --init -p 3000:3000 stronghold-protocol:local
```

`Dockerfile.dockerignore` 会覆盖上游的 `.dockerignore`，仅发送构建需要的文件。它会排除宿主机素材和依赖，由镜像内部重新生成。设 `FETCH_ASSETS=0` 可快速检查精简构建。

标签规则测试只需 Node.js 22+：

```bash
node --test tests/*.test.mjs
```

Linux / WSL / Git Bash 上可测试本地镜像：

```bash
bash scripts/smoke-image.sh stronghold-protocol:local linux/amd64
```

发布流水线在 `ubuntu-24.04`（amd64）与 `ubuntu-24.04-arm`（arm64）上分别原生构建、启动镜像，不使用 QEMU。两个任务使用同一个预先解析的上游提交，分别缓存依赖。检查覆盖健康接口、首页、前端库、游戏数据、WebSocket 握手和容器 HEALTHCHECK。

发布运行先将候选镜像按 digest 上传至 GHCR，再在对应原生 CPU 上测试该 digest。只有两个架构全部通过，才合并已测试的 digest 并更新 `latest` / SHA 标签，合并时不重新构建。任一架构失败会阻止标签更新，但 GHCR 可能保留无标签的候选镜像。PR 与非默认分支手动运行只测试本地镜像，不向 GHCR 上传。

检查不包含真实浏览器渲染和完整游戏对局。Actions 固定到提交 SHA，由 Dependabot 提议更新。

### ARM64 构建故障

若日志在 `npm ci` 阶段出现 `qemu: uncaught target signal 4 (Illegal instruction)` / exit 132，崩溃发生于 QEMU 下执行 Node/npm 的阶段，不足以证明游戏代码不支持 ARM64。上游生产依赖未声明 x86 专用限制；本流水线通过原生 ARM64 构建和服务测试验证实际兼容性。GitHub 提供 [原生 ARM64 Linux runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
