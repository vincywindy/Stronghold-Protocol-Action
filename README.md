# Stronghold Protocol Docker 自动构建

为 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 提供独立的 Docker 构建仓库。游戏源码在 Actions 运行时从上游获取，本仓库维护 Dockerfile、GitHub Actions 和部署配置，不需要手动同步游戏代码。

默认跟踪上游最新正式 **Release**（排除草稿与预发布），发布到 **GitHub Container Registry (GHCR)**，Docker 版本标签与上游 Release 标签一致，例如 `v0.2.1`：

```text
ghcr.io/<你的 GitHub 用户名或组织>/<本仓库名>:latest
```

镜像名称全部小写。支持 `linux/amd64` 与 `linux/arm64`，使用 Node.js 22 Alpine，以非 root 用户运行。

可选同步到 **Docker Hub**：配置下述凭据后启用，未配置时自动跳过，GHCR 照常发布。

## 1. 启用自动构建

1. 在 GitHub 创建仓库，例如 `Stronghold-Protocol-Action`，把本目录中的文件提交并推送到默认分支（通常为 `main`）。不要提交 `.cache/` 或下载的上游源码。
2. 首次推送构建文件会自动发布启用全部插件仓库来源的镜像。也可打开 **Actions → Check upstream updates → Run workflow** 检查并补齐自动镜像；**Build and publish Docker image** 手动运行只发布独立标签，不覆盖 `latest`。
3. 无需新增 Secrets：发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，工作流声明了 `contents: read` 与 `packages: write`。组织策略需允许这些操作；出现 `permission_denied: write_package` 时检查组织策略及同名 Package 的 Actions 访问权限。
4. 构建成功后，在仓库 **Packages** 中查看镜像，Actions 运行摘要中有完整镜像名称、上游提交和镜像 digest。
5. GHCR 新建包通常默认为私有。若希望免登录拉取，可在 Package settings 中把可见性改为 Public；保持私有时，部署主机需要先使用具有 `read:packages` 权限的 Personal access token (classic) 登录 `ghcr.io`。

官方参考：[GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 访问与可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### 触发规则

| 事件 | 行为 |
| --- | --- |
| 默认分支推送构建相关文件 | 默认启用全部插件仓库来源，构建、验证两个架构并发布 |
| 每 6 小时检查 | 只查询上游与镜像清单；需要时调用共享构建 / 补同步，默认启用全部插件仓库来源，不预装插件 |
| 手动构建 | 可指定上游版本、素材及插件；只发布独立标签，不更新 `latest` / `latest-lite` |
| Pull Request | 在原生 amd64 / arm64 runner 上构建并验证精简镜像，不登录、不发布 |
| 非默认分支推送 | 仅检查工作流、标签规则和 Compose 配置 |
| 在非默认分支手动运行 | 构建验证，但不发布 |

检查工作流位于 `.github/workflows/check-upstream.yml`，使用 cron `17 */6 * * *`，只在默认分支运行。计划时间为 UTC 00:17、06:17、12:17、18:17，即北京时间每天 **02:17、08:17、14:17、20:17**。检查 job 超时上限 5 分钟；无变化时跳过构建，有变化时在同一次运行中调用 `docker.yml` 可复用工作流。也可在 Actions → **Check upstream updates → Run workflow** 手动检查；这仍属于自动镜像维护，默认启用全部插件仓库来源，不预装插件。

检查阶段只检出本仓库脚本，通过 API 查询上游版本、提交与 GHCR / Docker Hub 镜像清单，不下载源码或素材。检查 job 仅需 `packages: read`；发布 job 使用 `packages: write` 调用共享构建，无需 `actions: write` 或额外 PAT。内部 `automatic` 参数与用户手动构建入口分开，自动发布排队后会再次检查 GHCR 并重新解析上游版本。

GitHub 可能排队延迟或丢弃高负载时的调度，不能保证准点执行；上游发布 Release 不会直接触发本仓库，通常在下一次六小时检查时跟进。公开仓库长期无活动时 GitHub 可能停用定时任务，可在 Actions 页面重新启用。参见 [GitHub 定时事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

定时检查通过 GitHub 的 latest Release API 获取正式版本，实际构建从其 Git Tag 检出代码，保持应用代码、镜像版本标签和镜像 `org.opencontainers.image.version` 一致。仅当该版本标签与 `latest` 指向同一个包含 amd64 / arm64 的镜像时，才跳过构建；含素材版本还会检查已经包含 Release 本地素材的标记，旧的无 3D 素材镜像会自动补建。同时检查镜像索引中的插件来源标记：旧镜像缺少来源，或登记的来源集合变化时，即使游戏版本未变也会补建；来源完整后不重复构建。检查失败会报错，不会当成“没有更新”。精简镜像独立检查带 `-lite` 的标签。固定历史 Release 时只检查该版本，不覆盖当前 `latest`。

版本未变且镜像已完整发布时不会定时刷新基础镜像或素材。手动构建可强制重建并发布独立标签；推送构建相关文件会重新构建自动发布标签。若上游移动了同名 Release Tag，已有标签不会仅因定时检查而重建。

### 可选配置

在 **Settings → Secrets and variables → Actions → Variables** 添加：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_REF` | `latest` | `latest` 自动跟踪最新正式 Release；也可固定 Release 标签，或指定分支 / Tag / 完整 SHA |
| `FETCH_ASSETS` | `1` | 是否包含素材；正式 Release 直接使用同版本完整包的全部素材、字体和清单；`0` 为精简镜像，只接受 `0` 或 `1` |
| `NODE_IMAGE` | `node:22-alpine` | Alpine 系列 Node 基础镜像，必须支持两个架构且兼容上游依赖；运行层使用 `apk` 安装补丁工具 Git |

主构建入口留空 `upstream_ref` 时使用 `UPSTREAM_REF`；填 `latest` 选择最新正式 Release。`include_assets` 覆盖 `FETCH_ASSETS`，默认勾选。手动构建始终重建；`image_tag` 指定独立标签，未选插件且留空时生成 `manual-<run_id>-<attempt>`（精简版追加 `-lite`）。**勾选任意插件仓库后必须填写 `image_tag`**，否则在下载前失败。显式标签按输入原样使用，精简版也不自动追加后缀。`UPSTREAM_REF=latest` 跟踪正式 Release；轮询分支 / SHA 时只检查对应 SHA 标签。

### 插件与游戏管理中心（统一入口，可跨仓库混用）

目前已收录以下插件仓库：

| 插件仓库 | 仓库地址 | 选择键前缀 |
| --- | --- | --- |
| Forge 工坊包 | [XiaMo233M/Stronghold-Protocol-Forge-Mods](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods) | `forge/` |
| 乐勒砳插件 | [llleeeqi/Stronghold-Protocol-Lele-Mods](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods) | `lele/` |

自动构建的 `latest` / `latest-lite` 默认启用所有已登记来源（目前为 Forge 和乐勒砳），管理器随容器启动，初始安装列表为空。直接部署即可在网页选择安装插件；以后新增登记仓库也会自动纳入。需要限制来源的手动镜像可按以下步骤构建：

1. 在 **Actions → Build and publish Docker image → Run workflow** 勾选需要的仓库，两个仓库可以同时勾选，默认均不勾选。
2. 填写独立的 `image_tag`，例如 `friends-manager`。勾选仓库只启用管理器中的下载来源，**构建时不下载、不安装任何第三方插件，也不修改游戏源码**。旧的 filter 输入框已移除，具体插件改在网页中选择。
3. 使用该标签部署，挂载 `/data` 并映射管理端口 3001。下方提供完整配置。
4. 进入管理页面，点击“刷新目录 / 检查插件更新”，搜索并勾选不同仓库的插件，再点“应用选择”。取消勾选并应用即卸载；更新时先刷新目录，再点“更新已选插件”。
5. 可选“应用后重启游戏”，或稍后点“重启游戏”。重启后在游戏房间中选择本局启用的插件。

目录按 **仓库名 + 插件名** 展示，当前快照含 Forge 30 项、乐勒砳 8 项，见 [插件列表](plugins/README.md)。网页刷新会发现已启用仓库的新条目，不需要为每次插件发布重新构建镜像。不会按玩法兼容性筛掉检索到的插件。

管理器采用上游相同的 **Node.js ES modules、原生 HTTP、Preact + HTM**，随镜像运行，使用独立端口。它通过上游公开的 `pluginsDir` 参数指定安装目录。构建阶段不修改游戏源码；安装 Lele 插件时，在运行时单独准备带宿主补丁的游戏副本。第三方脚本默认 `SP_PLUGIN_SCRIPTS=sandbox`；Lele 宿主兼容层是游戏代码适配，不是沙盒插件，也不要求切换到 trusted。管理器密码与 GitHub Token 不传给游戏进程。

Forge 使用上游离线导入器；原生/乐勒砳包复制到标准插件目录，并运行检查器。Forge 导入失败仍保留原包和诊断，供后续更新重试；下载、校验失败或安装 ID 冲突时，整次选择保持原状。Lele 安装须先通过宿主补丁和插件检查，不再把缺少宿主 API 的包当成安装完成。不会执行作者提供的 shell 安装器、npm 生命周期或素材生成脚本；需要额外步骤时必须由明确的适配器实现。

**Lele 宿主兼容层：** 安装任一 Lele 插件时，自动下载与插件同一提交的 `upstream.lock.json`、`patches/modpack-code.patch`、随包 `public/art` 资源和来源说明，校验 Git 文件哈希。根据锁文件核对游戏版本及补丁文件基线，在 `/data/generations/<ID>/hosts/` 中生成适配副本，初始化 API 1 的空功能槽；插件仍由房主在房间中勾选启用。`/app` 与 `/data/games/` 保持原版，Release 校验不会受到补丁影响。大素材和依赖通过内部链接复用，备份时应保留整个 `/data`。

已有旧版管理器安装的 Lele 插件，更新管理器镜像后，在网页保持原选择、再次点击“应用选择”，再重启游戏即可补装兼容层。不同提交的 Lele 插件不能混用同一宿主补丁，遇到提示时先刷新目录，再点“更新已选插件”。可同时安装 Forge/原生插件。取消全部 Lele 插件并应用、重启后恢复使用原版游戏副本。

当前收录的 Lele 补丁适配 **0.3.1 / API 1**。更新或回退游戏前，会检查所选插件的补丁是否适用；失败时保持当前游戏运行，不强行打补丁、不降级游戏。如果新版游戏尚无对应补丁，可先卸载全部 Lele 插件，再更新游戏。随包资源会安装，但不会执行 Lele 的联网素材生成流程，未包含的专属素材可能仍缺失。

安装状态为 `copied`（已复制）、`imported`（已导入）、`partial`（部分导入）、`bundled-only`（仅保留原包）。下载成功不等于玩法验证通过。所有已安装插件、原包、版本、来源提交、校验结果与游戏插件配置都放在 `/data`；新目录完成后才切换指针，游戏继续使用旧目录直至重启。一次成功操作后保留当前、上一次和仍在运行的目录，其余历史目录自动清理。

**标签隔离：** 手动构建勾选任意仓库必须填写自定义标签；任何手动构建都不更新 `latest` / `latest-lite`、上游 Release 或 SHA 标签。定时检查和推送构建默认启用全部来源，使用自动发布标签；构建时不自动安装插件。

### 插件开发者与目录维护

新增/更新插件的格式、适配接口及 PR 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，机器格式见 [catalog.schema.json](plugins/catalog.schema.json)，可复制 [原生插件提交示例](plugins/native-example.json)。只提交来源描述和必要适配代码，不把游戏素材或第三方原包提交到此仓库。

```bash
node scripts/refresh-plugin-catalog.mjs
node scripts/generate-plugin-workflows.mjs
node --test tests/*.test.mjs
```

刷新命令只检索仓库的索引/清单，不检验插件是否可玩；目录、生成的工作流和插件列表应一同通过 PR 提交。构建中固化可用来源与初始目录；运行时网页可刷新这些来源的新条目。自动轮询不会刷新插件或自动安装新条目。

### 可选推送到 Docker Hub

在 GitHub 仓库 **Settings → Secrets and variables → Actions → Secrets** 中添加：

| Secret | 内容 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 登录用户名 |
| `DOCKERHUB_TOKEN` | 具有目标仓库 Read / Write 权限的 Docker Hub Personal Access Token，勿填写账户密码 |

两个 Secret 都有值时才启用；未配置或只配置一个时，自动跳过 Docker Hub 登录和推送，不影响 GHCR。Token 配置参考 [Docker 官方文档](https://docs.docker.com/security/access-tokens/)。

默认镜像地址是 `docker.io/<DOCKERHUB_USERNAME>/<本 GitHub 仓库名的小写形式>`。若要指定仓库或组织，在 **Variables** 中添加 `DOCKERHUB_REPOSITORY`，例如 `your-name/stronghold-protocol` 或 `your-org/stronghold-protocol`，必须全小写，不含 `docker.io/`、标签或协议。提前在 Docker Hub 创建对应仓库并设置 Public / Private；用于登录的用户及 Token 需要该仓库的推送权限。

配置完成后，可手动运行 **Check upstream updates** 或等待轮询补齐自动发布的 Docker Hub 标签；手动构建则同步其独立标签。Docker Hub 与 GHCR 使用相同标签，同步两个架构及构建证明，不重复构建。轮询会比对自动标签的 manifest digest：已经一致则跳过；缺失或不同时补齐发布。

同步通过 [Skopeo](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md) 复制完整多架构镜像并校验 digest。凭据已配置但无效、权限不足或同步失败时，检查或 Docker Hub 同步任务会报错，已经发布成功的 GHCR 镜像仍可使用；修正配置后可重新运行任务或等待下一次定时检查。删除任一 Secret 即可停用 Docker Hub 推送。

使用 Docker Hub 部署时，只需将 Compose 的 `image` 改为实际地址，例如 `your-name/stronghold-protocol:latest`；私有仓库需先在部署主机执行 `docker login`。发布结果可在 Docker Hub 对应仓库的 **Tags** 页面及 Actions 运行摘要查看。

### 标签规则

| 构建内容 | 标签 |
| --- | --- |
| 自动构建最新正式 Release，含素材 | `<Release 标签>`、`latest`、`sha-<上游完整 SHA>` |
| 自动构建最新正式 Release，不下载素材 | `<Release 标签>-lite`、`latest-lite`、`sha-<上游完整 SHA>-lite` |
| 自动跟踪历史 Release | 对应 Release 和 SHA 标签，不覆盖 `latest` |
| 自动跟踪非 Release 分支 / Tag / SHA | 仅 SHA 标签 |
| 手动构建，填写 `image_tag` | 仅该标签；选插件时必填 |
| 手动构建，未选插件且未填标签 | `manual-<run_id>-<attempt>`（精简版加 `-lite`） |

`latest` 表示本仓库最近成功构建的上游最新正式 Release，版本标签原样保留上游的 `v` 前缀（如果有）。例如可用 `ghcr.io/vincywindy/stronghold-protocol-action:v0.2.1` 固定游戏版本。手动重建同一版本时，基础镜像、素材和构建配置仍可能变化；严格锁定部署应使用运行摘要中的 `ghcr.io/…@sha256:…`。

## 2. Docker Compose 部署

### 单文件部署（无需 `.env`）

在一个空目录中创建 `compose.yaml`，复制以下完整配置即可使用游戏和管理中心，无需下载仓库或创建 `.env` 文件。`latest` 默认启用全部插件仓库来源，管理中心可用于安装插件和更新游戏；插件需要在管理页面选择后安装。

环境变量含义参考[上游「端口与配置」说明](https://github.com/sganggs/Stronghold-Protocol#端口与配置)，下面的注释补充了容器端口与监听地址的配置方式。

```yaml
services:
  stronghold:
    image: ghcr.io/vincywindy/stronghold-protocol-action:latest
    restart: unless-stopped
    init: true
    ports:
      - "3000:3000"
      # 管理页面默认仅供宿主机本机访问；远程访问配置见下文。
      - "127.0.0.1:3001:3001"
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
      # 1 显式启用管理中心；auto 仅在镜像启用了插件仓库时启用；0 关闭。
      PLUGIN_MANAGER_ENABLED: "1"
      # 管理器在容器内监听所有网卡，访问范围由上方宿主机端口映射控制。
      PLUGIN_MANAGER_HOST: "0.0.0.0"
      PLUGIN_MANAGER_PORT: "3001"
      # 可选密码：填写后浏览器会弹出登录框，用户名固定为 admin。
      # 留空表示无需登录；直接写 YAML 时，密码中的 $ 要写成 $$。
      PLUGIN_MANAGER_PASSWORD: ""
      PLUGIN_MANAGER_ALLOWED_HOSTS: ""
      PLUGIN_MANAGER_DATA_DIR: "/data"
      SP_PLUGIN_SCRIPTS: "sandbox"
      GAME_RELEASE_API: "https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest"
      # 可选 HTTPS 更新包直链，填写后优先于上方 Release API。
      GAME_UPDATE_URL: ""
      GAME_UPDATE_SHA256: ""
      GITHUB_TOKEN: ""
    volumes:
      - manager-data:/data
    # 对局保存在内存中，挂载数据卷也无法在重启后恢复对局。
    stop_grace_period: 30s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

volumes:
  manager-data:
```

在该目录执行：

```bash
docker compose pull
docker compose up -d
```

游戏访问 `http://<服务器地址>:3000`；管理中心在宿主机本机访问 `http://127.0.0.1:3001`。从其他电脑访问管理页面时，先设置 `PLUGIN_MANAGER_PASSWORD`，再将管理映射改为 `"3001:3001"`，使用 `http://<服务器地址>:3001` 登录。

端口映射格式为 `宿主机地址:宿主机端口:容器端口`（地址可省略）。例如游戏改为 `"8080:3000"`、管理中心改为 `"127.0.0.1:8081:3001"`，只改变访问端口；容器内的 `PORT=3000` 与 `PLUGIN_MANAGER_PORT=3001` 保持不变。管理中心的密码、端口及持久化说明见[管理器部署与持久化](#管理器部署与持久化)。

### 使用仓库配置与 `.env`

复制 `.env.example` 为 `.env`，将 `IMAGE` 修改为你的实际镜像地址：

```dotenv
IMAGE=ghcr.io/your-name/stronghold-protocol-action:latest
HTTP_PORT=3000
# latest 已启用全部来源，auto 会启动管理中心。
PLUGIN_MANAGER_ENABLED=auto
MANAGER_BIND_ADDRESS=127.0.0.1
MANAGER_PORT=3001
PLUGIN_MANAGER_PASSWORD=
```

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f
```

访问 `http://<服务器地址>:3000`。镜像内置 `/healthz` 健康检查；联机 WebSocket 路径为 `/ws`，使用反向代理时须转发 WebSocket 升级，并将游戏部署在域名根路径。

容器健康检查会随运行模式切换：原版模式检查游戏端口的 `/healthz`；管理器模式检查管理端口的 `/healthz`。管理器存活但游戏启动失败时，容器仍保持健康，确保 Traefik 不会同时移除管理页面的恢复入口。游戏是否就绪可在管理页面查看，或单独检查游戏端口。管理端 `/healthz` 无需密码，仅返回存活标记，不包含游戏状态或凭据。

只启动原版游戏、不启用管理器的 Docker 命令：

```bash
docker run -d --name stronghold --init --restart unless-stopped \
  -p 3000:3000 -e PLUGIN_MANAGER_ENABLED=0 \
  ghcr.io/your-name/stronghold-protocol-action:latest
```

更新容器镜像（管理器及运行环境；已持久化的游戏通过管理页面更新）：

```bash
docker compose pull
docker compose up -d
```

游戏房间和对局保存在内存中，更新或重启会结束当前对局。启用管理器时，必须保留 `/data` 数据卷以保留插件和网页更新后的游戏；数据卷不能恢复对局。镜像发布不会自动更新已运行的容器。

使用 `.env` 方式时，`HTTP_PORT` 改宿主机端口，容器端口固定为 3000。`BIND_ADDRESS=127.0.0.1` 可用于同机反向代理；默认 `0.0.0.0` 允许从局域网访问。其余变量见 `.env.example` 和[上游部署文档](https://github.com/sganggs/Stronghold-Protocol/blob/master/docs/DEPLOY.md)。

### 管理器部署与持久化

使用仓库 `compose.yaml` 时，已挂载命名卷 `manager-data:/data`，管理端口默认仅绑定宿主机 `127.0.0.1:3001`。构建时选了来源的镜像自动启用管理器；未选来源也可以设置 `PLUGIN_MANAGER_ENABLED=1`，仅使用游戏更新功能。设为 `0` 则直接运行镜像内的原版游戏。

例如在 `.env` 中设置：

```dotenv
IMAGE=ghcr.io/your-name/stronghold-protocol-action:friends-manager
PLUGIN_MANAGER_ENABLED=auto
MANAGER_BIND_ADDRESS=0.0.0.0
MANAGER_PORT=3001
PLUGIN_MANAGER_PASSWORD='替换为自己的管理密码'
SP_PLUGIN_SCRIPTS=sandbox
```

运行 `docker compose up -d` 后访问 `http://<服务器地址>:3001`。若仍使用默认 `MANAGER_BIND_ADDRESS=127.0.0.1`，只能在服务器本机访问 `http://127.0.0.1:3001`；仅修改端口数字不会开放远程访问。

**密码登录：** 管理页使用浏览器原生 HTTP Basic 登录框，没有单独的网页注册/登录表单。用户名固定为 **`admin`**，密码为 `PLUGIN_MANAGER_PASSWORD` 的值。留空表示不要求登录，不存在默认密码。`.env` 中密码可用单引号包裹，保留 `$`、`#` 等字符；直接写 Compose YAML 时，字面的 `$` 需写成 `$$`。远程访问建议通过 HTTPS 反向代理。

**修改配置后生效：** 保存 `.env` 或 Compose YAML，再运行 `docker compose up -d`，使 Compose 按新配置重建容器；单独执行 `docker compose restart` 不会重新读取环境变量。修改密码后，若浏览器仍缓存旧凭据，可用无痕窗口重新登录。重建时保留原来的 `manager-data` 卷。

**部署环境变量：** 下表适用于仓库自带的 `compose.yaml`；`.env` 用于 Compose 替换变量，并非其中所有值都会同名传入容器。

| `.env` 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `IMAGE` | 必填 | 镜像完整地址；插件管理需要使用已启用对应仓库来源的镜像 |
| `BIND_ADDRESS` | `0.0.0.0` | 游戏端口在宿主机的绑定地址 |
| `HTTP_PORT` | `3000` | 游戏宿主机访问端口，映射到容器 `3000` |
| `PLUGIN_MANAGER_ENABLED` | `auto` | `auto`：有插件来源才启用；`1`：始终启用；`0`：关闭管理器并直接运行镜像内游戏 |
| `MANAGER_BIND_ADDRESS` | `127.0.0.1` | 管理端口在宿主机的绑定地址；`0.0.0.0` 允许通过服务器网络地址访问 |
| `MANAGER_PORT` | `3001` | 管理页面宿主机访问端口，映射到容器 `3001`；如设 `8081`，访问地址末尾为 `:8081` |
| `PLUGIN_MANAGER_PASSWORD` | 空 | 管理页可选密码，用户名固定为 `admin`；空值不要求登录 |
| `PLUGIN_MANAGER_ALLOWED_HOSTS` | 空 | 无密码时允许的访问域名，如 `manager.example.com`；多个主机名用逗号分隔、不加空格，不含协议、端口或路径。它是 Host 检查配置，不是客户端 IP 白名单 |
| `SP_PLUGIN_SCRIPTS` | `sandbox` | 游戏插件脚本使用沙盒模式 |
| `SP_COMBAT` / `SP_VERIFY` / `TRUST_PROXY` | `client` / `off` / `auto` | 游戏战斗计算、结果复算与代理头配置，含义见上方完整示例 |

Release 更新相关的 `GAME_RELEASE_API`、`GAME_UPDATE_URL`、`GAME_UPDATE_SHA256`、`GITHUB_TOKEN` 见[网页更新游戏与可配置的 Release URL](#网页更新游戏与可配置的-release-url)。

仓库 Compose 固定容器内 `PLUGIN_MANAGER_PORT=3001`、`PLUGIN_MANAGER_DATA_DIR=/data`，管理器的 `PLUGIN_MANAGER_HOST` 默认 `0.0.0.0`。不要将 `MANAGER_PORT` 与容器内监听端口混淆：只在 `.env` 添加 `PLUGIN_MANAGER_PORT=8081` 不会改变仓库 Compose 的固定值。确需改变内部端口时，同时修改 Compose 的 `environment` 和端口映射右侧；改变数据目录时，也必须同步调整卷挂载目标。容器内监听地址应保持 `0.0.0.0`，宿主机访问范围由 `MANAGER_BIND_ADDRESS` 控制。

使用反向代理时，让管理域名的根路径转发到 `http://127.0.0.1:3001`（或所设宿主机端口），保留原始 `Host`、`Authorization` 与 `X-Manager-Token` 请求头。无密码且使用域名访问时，需把该域名加入 `PLUGIN_MANAGER_ALLOWED_HOSTS`。当前页面使用根路径资源与 `/api/*`，不能直接挂到游戏域名的 `/manager/` 子路径。

不用 Compose 时，下面是启用管理器的完整 Docker 启动示例（Linux / WSL / Git Bash；替换镜像地址和密码）：

```bash
docker run -d --name stronghold --init --restart unless-stopped \
  -p 3000:3000 -p 127.0.0.1:3001:3001 \
  -e PLUGIN_MANAGER_ENABLED=1 \
  -e PLUGIN_MANAGER_PORT=3001 \
  -e PLUGIN_MANAGER_PASSWORD='替换为自己的管理密码' \
  -e PLUGIN_MANAGER_DATA_DIR=/data \
  -e SP_PLUGIN_SCRIPTS=sandbox \
  -v stronghold-manager-data:/data \
  ghcr.io/your-name/stronghold-protocol-action:friends-manager
```

此命令默认仅允许宿主机本机访问管理端；需远程访问时，将 `-p 127.0.0.1:3001:3001` 改为 `-p 3001:3001`。在 `docker run` 中，端口发布由 `-p` 控制，设置 `-e MANAGER_PORT=...` 不会创建映射。上方单文件 Compose 示例已包含完整管理器配置，可直接复制使用，无需拼接 YAML 片段。

管理器在 `/opt/manager`，镜像内的游戏在 `/app`。首次启用时会复制游戏到 `/data/games/<ID>`，大素材镜像首次启动需要额外时间和磁盘空间；之后从数据卷启动。插件目录位于 `/data/generations/<ID>/plugins`，原包位于同代的 `packages/`；`game.json` 与 `current.json` 记录当前选择。备份整个 `/data`，不要只备份某个生成目录。一个数据卷只供一个管理器实例使用。宿主机绑定目录需授予容器用户（默认 UID 1000）写权限。

已有数据卷优先于镜像里的游戏版本，重新拉取镜像不会覆盖网页更新后的版本。升级管理器或 Node.js 时仍需拉取新镜像；如需从镜像重新初始化游戏，应先停容器、备份数据，再移走 `/data/game.json` 和 `/data/games`，保留插件数据。

### 网页更新游戏与可配置的 Release URL

管理页面提供“检查更新”“下载更新并重启”和“回退”。默认查询上游最新正式 Release，优先下载 `Stronghold-Protocol-v<版本>-update.zip`；基线不匹配或验证失败时尝试同一 Release 的 `-lite.zip`。先在新目录验证清单、文件大小和哈希、适用基线、删除清单，再启动并检查健康接口；启动失败恢复原版本，页面仍可使用。更新会保留已有素材及独立插件目录，但不承诺新游戏版本兼容全部插件。重启会结束正在进行的对局。

部署时可配置以下环境变量，无需修改代码或重新构建镜像：

| 配置 | 默认 / 用途 |
| --- | --- |
| `GAME_RELEASE_API` | `https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest`；可改成指定 Tag 的 GitHub Release API、fork 或返回兼容 JSON 的镜像 API |
| `GAME_UPDATE_URL` | 默认空；指定 HTTPS 更新 ZIP 的直链，优先于 Release API。可使用符合上游格式的 update 或 lite ZIP |
| `GAME_UPDATE_SHA256` | 固定 ZIP 的可选 SHA-256；提供后必须匹配。使用 API 时自动使用资产的 SHA-256（若 API 提供） |
| `GITHUB_TOKEN` | 可选，提高 GitHub API 额度；只发给 `api.github.com`，不随重定向发送至其他主机 |

固定直链不会自动发现更新，也没有其他包作为回退下载源；其中的 `MANIFEST.json` / `UPDATE.json` 仍须满足上游格式。只接受 HTTPS，不支持任意命令或普通源码 ZIP。更新包不能覆盖用户配置或插件目录。需要更新 Node.js、系统依赖或包含平台原生扩展的版本须重建镜像。管理器只替换应用版本，不替换自身。

当前管理接口基于上游 v0.3.1 的启动、导入及更新协议验证；手动选择缺少这些接口的旧版本时，应关闭管理器使用原版运行方式。

## 3. 素材范围

默认的正式 Release 镜像直接使用**同版本官方完整 Release ZIP**中的全部素材：`public/assets/`（公开美术、音频、模型及本地 3D 素材）、`public/fonts/`，以及配套的 `data/assets.json`、`data/local-assets.json` 和存在时的 `data/local-fx.json`。无需在 Actions 或部署主机安装《明日方舟》客户端。

Actions 每轮只下载一次完整包，按 GitHub Release API 提供的大小与 SHA-256 校验，核对包内版本，检查所有素材清单引用的文件与必要的棋盘文件，再共享给两个架构。只提取上述素材和清单；应用源码仍来自对应 Git Tag，生产依赖仍由 `npm ci` 安装。校验或完整性检查失败会停止发布。

原版正式 Release 构建不再运行 `tools/fetch-assets.mjs`，避免重新抓取第三方音频/模型索引造成清单缩水；原版流程不会用 `--allow-shrink` 跳过保护。不同架构使用相同的素材快照。未关联 Release 的分支构建使用在线下载。启用插件管理来源不改变素材构建流程，不运行第三方素材生成脚本。

镜像记录完整包的校验值与素材来源。容器测试检查全部清单引用文件存在且非空，同时检查素材清单、棋盘贴图、模型配置、地块表和 three.js 能否通过 HTTP 访问。实际 3D 渲染仍需浏览器支持 WebGL2，且未被玩家设置切换为 2D。该流程不运行完整浏览器游戏测试。

手动构建未关联正式 Release 的分支或提交时，无法确定匹配的完整包，因此仅下载公开素材，不自动混用其他版本的本地素材。需要自行补充时，可以将匹配的 `public/assets/local/` 与 `data/local-assets.json` 分别只读挂载到 `/app/public/assets/local/` 和 `/app/data/local-assets.json`。不要用空目录覆盖镜像中的整个 `/app/public/assets`。

使用管理器时，以下 `/app` 素材挂载仅用于首次初始化；已有持久化游戏不会随镜像目录变化。精简镜像不自动下载素材，直接运行会使用缺图占位或回退效果。可从同一版本已完成上游 setup 的目录只读挂载 `public/assets`、`public/fonts`、`data/assets.json`，对应到镜像的 `/app/` 下相同路径。

本项目沿用上游运行方式，保留镜像内 `/app/LICENSE`、`/app/NOTICE.md`、`/app/THIRD-PARTY-NOTICES.md`。上游代码声明为 GPL-3.0-or-later；游戏素材和数据不属于该代码许可证的授权范围，遵循[上游声明](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)，仅用于个人非商业学习与娱乐。

## 4. 本地构建与验证

需要 Git、Docker Engine / Docker Desktop 与 Buildx。仓库根目录作为命令运行目录，上游目录作为 Docker 构建上下文：

```bash
git clone --depth 1 https://github.com/sganggs/Stronghold-Protocol.git upstream
docker buildx build --load --build-context manager=. -f Dockerfile --build-arg FETCH_ASSETS=1 -t stronghold-protocol:local ./upstream
docker run --rm --init -p 3000:3000 stronghold-protocol:local
```

`Dockerfile.dockerignore` 会覆盖上游的 `.dockerignore`，仅发送构建需要的文件。它会排除宿主机素材和依赖；构建阶段生成前端库并导入已校验的 Release 素材，或为分支构建在线下载素材。最终镜像复制整个筛选后的构建目录，避免另一份目录清单遗漏服务端依赖（如 Studio 导入的 `tools/assets/`）。设 `FETCH_ASSETS=0` 可快速检查精简构建。命名构建上下文 `manager=.` 必须指向本仓库；可加 `--build-arg PLUGIN_SOURCES=forge,lele` 启用两个来源，留空时默认不启用管理器。

本地构建正式 Release 时，推荐直接导入完整包素材。需要 Python 3.11+，源码与素材必须使用同一个 Release（下面以 `v0.3.1` 为例）：

```bash
git -C upstream fetch --depth 1 origin tag v0.3.1
git -C upstream checkout --detach v0.3.1
python scripts/prepare-release-assets.py --tag v0.3.1 --destination upstream/.container-assets
docker buildx build --load --build-context manager=. -f Dockerfile --build-arg FETCH_ASSETS=1 --build-arg INCLUDE_LOCAL_ASSETS=1 -t stronghold-protocol:local ./upstream
```

`INCLUDE_LOCAL_ASSETS=1` 沿用旧参数名，现在表示导入全部 Release 素材及配套清单，并跳过在线素材下载。旧版本脚本生成的仅本地素材目录需要重新准备。

`.container-assets` 必须为空或不存在，避免混入其他版本素材；准备脚本仅需 Python 标准库，不依赖 UnityPy，也不启动游戏客户端。

标签规则测试只需 Node.js 22+：

```bash
node --test tests/*.test.mjs
```

Linux / WSL / Git Bash 上可测试本地镜像：

```bash
bash scripts/smoke-image.sh stronghold-protocol:local linux/amd64
```

发布流水线在 `ubuntu-24.04`（amd64）与 `ubuntu-24.04-arm`（arm64）上分别原生构建、启动镜像，不使用 QEMU。两个任务使用同一个预先解析的上游提交，分别缓存依赖。检查覆盖健康接口、首页、前端库、游戏数据、WebSocket 握手和容器 HEALTHCHECK。

发布运行先将候选镜像按 digest 上传至 GHCR，再在对应原生 CPU 上测试该 digest。只有两个架构全部通过，才合并已测试的 digest 并发布本次应有的标签：自动构建启用全部来源并使用自动发布标签，手动构建只使用独立标签，合并时不重新构建。启用管理器来源的镜像额外检查管理接口、来源列表、初始插件为空及游戏进程健康；不在构建阶段安装第三方插件。任一架构失败会阻止标签更新，但 GHCR 可能保留无标签候选镜像。PR 与非默认分支手动运行只测试本地镜像，不向 GHCR 上传。

检查不包含真实浏览器渲染和完整游戏对局。Actions 固定到提交 SHA，由 Dependabot 提议更新。

### ARM64 构建故障

若日志在 `npm ci` 阶段出现 `qemu: uncaught target signal 4 (Illegal instruction)` / exit 132，崩溃发生于 QEMU 下执行 Node/npm 的阶段，不足以证明游戏代码不支持 ARM64。上游生产依赖未声明 x86 专用限制；本流水线通过原生 ARM64 构建和服务测试验证实际兼容性。GitHub 提供 [原生 ARM64 Linux runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
