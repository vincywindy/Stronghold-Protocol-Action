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
2. 首次推送构建文件会自动发布原版镜像。也可打开 **Actions → Check upstream updates → Run workflow** 检查并补齐原版镜像；**Build and publish Docker image** 手动运行只发布独立标签，不覆盖 `latest`。
3. 无需新增 Secrets：发布使用 GitHub 自动提供的 `GITHUB_TOKEN`，工作流声明了 `contents: read` 与 `packages: write`。组织策略需允许这些操作；出现 `permission_denied: write_package` 时检查组织策略及同名 Package 的 Actions 访问权限。
4. 构建成功后，在仓库 **Packages** 中查看镜像，Actions 运行摘要中有完整镜像名称、上游提交和镜像 digest。
5. GHCR 新建包通常默认为私有。若希望免登录拉取，可在 Package settings 中把可见性改为 Public；保持私有时，部署主机需要先使用具有 `read:packages` 权限的 Personal access token (classic) 登录 `ghcr.io`。

官方参考：[GitHub Actions 发布 Docker 镜像](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)、[GHCR 访问与可见性](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### 触发规则

| 事件 | 行为 |
| --- | --- |
| 默认分支推送构建相关文件 | 构建、验证两个架构并发布 |
| 每 6 小时检查 | 只查询上游与镜像清单；需要时调用共享构建 / 补同步，插件固定为空 |
| 手动构建 | 可指定上游版本、素材及插件；只发布独立标签，不更新 `latest` / `latest-lite` |
| Pull Request | 在原生 amd64 / arm64 runner 上构建并验证精简镜像，不登录、不发布 |
| 非默认分支推送 | 仅检查工作流、标签规则和 Compose 配置 |
| 在非默认分支手动运行 | 构建验证，但不发布 |

检查工作流位于 `.github/workflows/check-upstream.yml`，使用 cron `17 */6 * * *`，只在默认分支运行。计划时间为 UTC 00:17、06:17、12:17、18:17，即北京时间每天 **02:17、08:17、14:17、20:17**。检查 job 超时上限 5 分钟；无变化时跳过构建，有变化时在同一次运行中调用 `docker.yml` 可复用工作流。也可在 Actions → **Check upstream updates → Run workflow** 手动检查；这仍属于自动原版维护，插件固定为空。

检查阶段只检出本仓库脚本，通过 API 查询上游版本、提交与 GHCR / Docker Hub 镜像清单，不下载源码或素材。检查 job 仅需 `packages: read`；发布 job 使用 `packages: write` 调用共享构建，无需 `actions: write` 或额外 PAT。内部 `automatic` 参数与用户手动构建入口分开，自动发布排队后会再次检查 GHCR 并重新解析上游版本。

GitHub 可能排队延迟或丢弃高负载时的调度，不能保证准点执行；上游发布 Release 不会直接触发本仓库，通常在下一次六小时检查时跟进。公开仓库长期无活动时 GitHub 可能停用定时任务，可在 Actions 页面重新启用。参见 [GitHub 定时事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

定时检查通过 GitHub 的 latest Release API 获取正式版本，实际构建从其 Git Tag 检出代码，保持应用代码、镜像版本标签和镜像 `org.opencontainers.image.version` 一致。仅当该版本标签与 `latest` 指向同一个包含 amd64 / arm64 的镜像时，才跳过构建；含素材版本还会检查已经包含 Release 本地素材的标记，旧的无 3D 素材镜像会自动补建。检查失败会报错，不会当成“没有更新”。精简镜像独立检查带 `-lite` 的标签。固定历史 Release 时只检查该版本，不覆盖当前 `latest`。

版本未变且镜像已完整发布时不会定时刷新基础镜像或素材。手动构建可强制重建并发布独立标签；推送构建相关文件会重新构建自动原版标签。若上游移动了同名 Release Tag，已有标签不会仅因定时检查而重建。

### 可选配置

在 **Settings → Secrets and variables → Actions → Variables** 添加：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `UPSTREAM_REF` | `latest` | `latest` 自动跟踪最新正式 Release；也可固定 Release 标签，或指定分支 / Tag / 完整 SHA |
| `FETCH_ASSETS` | `1` | 是否包含素材；正式 Release 直接使用同版本完整包的全部素材、字体和清单；`0` 为精简镜像，只接受 `0` 或 `1` |
| `NODE_IMAGE` | `node:22-alpine` | Node 基础镜像，必须支持两个架构且兼容上游依赖 |

主构建入口留空 `upstream_ref` 时使用 `UPSTREAM_REF`；填 `latest` 选择最新正式 Release。`include_assets` 覆盖 `FETCH_ASSETS`，默认勾选。手动构建始终重建；`image_tag` 指定独立标签，未选插件且留空时生成 `manual-<run_id>-<attempt>`（精简版追加 `-lite`）。**选择任意插件后必须填写 `image_tag`**，否则在下载前失败。显式标签按输入原样使用，精简版也不自动追加后缀。`UPSTREAM_REF=latest` 跟踪正式 Release；轮询分支 / SHA 时只检查对应 SHA 标签。

### 选择插件构建（统一入口，可跨仓库混用）

目前已收录以下插件仓库：

| 插件仓库 | 仓库地址 | 选择键前缀 |
| --- | --- | --- |
| Forge 工坊包 | [XiaMo233M/Stronghold-Protocol-Forge-Mods](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods) | `forge/` |
| 乐勒砳插件 | [llleeeqi/Stronghold-Protocol-Lele-Mods](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods) | `lele/` |

1. 打开 Actions 中的 **Build and publish Docker image**，点击 **Run workflow**。原来的分仓库插件工作流已合并到此入口。
2. 在 **插件 1–21** 的下拉框中选择插件。**每个下拉框都包含所有仓库的插件，可以自由混选**，名称为 **仓库名 + 插件名 [选择键]**，默认均为“不添加插件”。当前目录包含 Forge 30 项、乐勒砳 8 项，完整列表见 [插件目录](plugins/README.md)。
3. 填写 `image_tag`，例如 `friends-031`，并选择游戏版本与是否包含素材。
4. 例如在“插件 1”选择 Forge 的夜间主题，在“插件 2”选择乐勒砳的回合插件，即可一起打包。超过 21 项或批量选择时，在 `plugins` 填入逗号分隔的选择键，例如 `forge/theme-night,lele/lele-rounds`；该字段与下拉框选择合并，重复项自动去重。无需填满所有下拉框。
5. 等待两个架构验证后发布；部署时将 Compose 的 `image` 改为该自定义标签。

GitHub 每个手动工作流最多 25 个输入项，且下拉框只能单选，因此统一表单采用 21 个插件选择位，加上版本、素材、镜像标签和补充插件 4 个字段。全部插件都能从每个选择位中找到，无需切换工作流；`plugins` 字段可补充任意数量的已收录插件。下拉选项由目录自动生成。参考 [GitHub workflow_dispatch 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs)。

**收录不做兼容性筛选。** 每次手动构建拉取来源 `ref`（当前均为 `main`）的最新提交，只解析一次，再将相同的源码、插件和素材交给 amd64 / arm64。Forge 从该提交的 `mods/index.json` 获取所选包的新版本、路径和 SHA-256；乐勒砳读取最新插件目录。已有插件更新无需改 Action，新出现的插件需要刷新目录并合并生成的工作流。

所选原包始终进入 `/app/plugin-sources/`，同时尽力安装到 `/app/plugins/`：Forge 使用游戏自带导入器；乐勒砳在本体提交与其 `upstream.lock.json` 一致时应用宿主补丁。导入失败、部分导入、宿主版本不匹配只记录状态，不阻止原包进入镜像；下载失败、文件校验失败及基础游戏启动失败仍会终止构建。镜像可启动并不代表每个插件的玩法已适配。脚本执行开关保持游戏默认值，安装成功的插件仍需在游戏中开启。

镜像中的 `/app/plugin-build.json` 记录选择键、实际版本、来源提交、原包路径及处理状态：`copied` 已复制、`imported` 已导入、`partial` 部分导入、`bundled-only` 仅保留原包。构建摘要和 `plugin-reports` 附件保存相同记录及导入诊断。乐勒砳全素材构建会额外尝试作者的素材生成流程；无法获取的插件素材记入诊断。精简版不主动下载游戏/扩展素材，但第三方原包自带的素材仍保留。

**标签隔离：** 手动构建只发布一个独立标签，不发布共享的上游 SHA 或 Release 别名，也不覆盖 `latest` / `latest-lite`。`latest`、`latest-*`、`sha-*` 和 `v0.3.1` / `0.3.1-lite` 这类版本标签不能用作自定义标签。轮询永远传入空插件列表，不会继承上一次手动选择。插件镜像同样可同步到 Docker Hub，使用相同独立标签。

### 插件开发者与目录维护

新增/更新插件的格式、适配接口及 PR 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，机器格式见 [catalog.schema.json](plugins/catalog.schema.json)，可复制 [原生插件提交示例](plugins/native-example.json)。只提交来源描述和必要适配代码，不把游戏素材或第三方原包提交到此仓库。

```bash
node scripts/refresh-plugin-catalog.mjs
node scripts/generate-plugin-workflows.mjs
node --test tests/*.test.mjs
```

刷新命令只检索仓库的索引/清单，不检验插件是否可玩；目录、生成的工作流和插件列表应一同通过 PR 提交。自动轮询不会刷新插件或自动安装新条目。

### 可选推送到 Docker Hub

在 GitHub 仓库 **Settings → Secrets and variables → Actions → Secrets** 中添加：

| Secret | 内容 |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub 登录用户名 |
| `DOCKERHUB_TOKEN` | 具有目标仓库 Read / Write 权限的 Docker Hub Personal Access Token，勿填写账户密码 |

两个 Secret 都有值时才启用；未配置或只配置一个时，自动跳过 Docker Hub 登录和推送，不影响 GHCR。Token 配置参考 [Docker 官方文档](https://docs.docker.com/security/access-tokens/)。

默认镜像地址是 `docker.io/<DOCKERHUB_USERNAME>/<本 GitHub 仓库名的小写形式>`。若要指定仓库或组织，在 **Variables** 中添加 `DOCKERHUB_REPOSITORY`，例如 `your-name/stronghold-protocol` 或 `your-org/stronghold-protocol`，必须全小写，不含 `docker.io/`、标签或协议。提前在 Docker Hub 创建对应仓库并设置 Public / Private；用于登录的用户及 Token 需要该仓库的推送权限。

配置完成后，可手动运行 **Check upstream updates** 或等待轮询补齐原版 Docker Hub 标签；手动构建则同步其独立标签。Docker Hub 与 GHCR 使用相同标签，同步两个架构及构建证明，不重复构建。轮询会比对自动标签的 manifest digest：已经一致则跳过；缺失或不同时补齐发布。

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

默认的正式 Release 镜像直接使用**同版本官方完整 Release ZIP**中的全部素材：`public/assets/`（公开美术、音频、模型及本地 3D 素材）、`public/fonts/`，以及配套的 `data/assets.json`、`data/local-assets.json` 和存在时的 `data/local-fx.json`。无需在 Actions 或部署主机安装《明日方舟》客户端。

Actions 每轮只下载一次完整包，按 GitHub Release API 提供的大小与 SHA-256 校验，核对包内版本，检查所有素材清单引用的文件与必要的棋盘文件，再共享给两个架构。只提取上述素材和清单；应用源码仍来自对应 Git Tag，生产依赖仍由 `npm ci` 安装。校验或完整性检查失败会停止发布。

原版正式 Release 构建不再运行 `tools/fetch-assets.mjs`，避免重新抓取第三方音频/模型索引造成清单缩水；原版流程不会用 `--allow-shrink` 跳过保护。不同架构使用相同的素材快照。未关联 Release 的分支构建使用在线下载。显式选择乐勒砳时，插件准备阶段会额外尝试作者的扩展素材流程，状态写入插件清单，不改变自动原版发布。

镜像记录完整包的校验值与素材来源。容器测试检查全部清单引用文件存在且非空，同时检查素材清单、棋盘贴图、模型配置、地块表和 three.js 能否通过 HTTP 访问。实际 3D 渲染仍需浏览器支持 WebGL2，且未被玩家设置切换为 2D。该流程不运行完整浏览器游戏测试。

手动构建未关联正式 Release 的分支或提交时，无法确定匹配的完整包，因此仅下载公开素材，不自动混用其他版本的本地素材。需要自行补充时，可以将匹配的 `public/assets/local/` 与 `data/local-assets.json` 分别只读挂载到 `/app/public/assets/local/` 和 `/app/data/local-assets.json`。不要用空目录覆盖镜像中的整个 `/app/public/assets`。

精简镜像不自动下载素材，直接运行会使用缺图占位或回退效果。可从同一版本已完成上游 setup 的目录只读挂载 `public/assets`、`public/fonts`、`data/assets.json`，对应到镜像的 `/app/` 下相同路径。

本项目沿用上游运行方式，保留镜像内 `/app/LICENSE`、`/app/NOTICE.md`、`/app/THIRD-PARTY-NOTICES.md`。上游代码声明为 GPL-3.0-or-later；游戏素材和数据不属于该代码许可证的授权范围，遵循[上游声明](https://github.com/sganggs/Stronghold-Protocol/blob/master/NOTICE.md)，仅用于个人非商业学习与娱乐。

## 4. 本地构建与验证

需要 Git、Docker Engine / Docker Desktop 与 Buildx。仓库根目录作为命令运行目录，上游目录作为 Docker 构建上下文：

```bash
git clone --depth 1 https://github.com/sganggs/Stronghold-Protocol.git upstream
docker build -f Dockerfile --build-arg FETCH_ASSETS=1 -t stronghold-protocol:local ./upstream
docker run --rm --init -p 3000:3000 stronghold-protocol:local
```

`Dockerfile.dockerignore` 会覆盖上游的 `.dockerignore`，仅发送构建需要的文件。它会排除宿主机素材和依赖；构建阶段生成前端库并导入已校验的 Release 素材，或为分支构建在线下载素材。最终镜像复制整个筛选后的构建目录，避免另一份目录清单遗漏服务端依赖（如 Studio 导入的 `tools/assets/`）。设 `FETCH_ASSETS=0` 可快速检查精简构建。

本地构建正式 Release 时，推荐直接导入完整包素材。需要 Python 3.11+，源码与素材必须使用同一个 Release（下面以 `v0.3.1` 为例）：

```bash
git -C upstream fetch --depth 1 origin tag v0.3.1
git -C upstream checkout --detach v0.3.1
python scripts/prepare-release-assets.py --tag v0.3.1 --destination upstream/.container-assets
docker build -f Dockerfile --build-arg FETCH_ASSETS=1 --build-arg INCLUDE_LOCAL_ASSETS=1 -t stronghold-protocol:local ./upstream
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

发布运行先将候选镜像按 digest 上传至 GHCR，再在对应原生 CPU 上测试该 digest。只有两个架构全部通过，才合并已测试的 digest 并发布本次应有的标签：自动构建使用原版标签，手动构建只使用独立标签，合并时不重新构建。插件镜像额外检查所有选中原包及其 SHA-256 均实际包含在镜像中，不检查插件玩法是否可用。任一架构失败会阻止标签更新，但 GHCR 可能保留无标签候选镜像。PR 与非默认分支手动运行只测试本地镜像，不向 GHCR 上传。

检查不包含真实浏览器渲染和完整游戏对局。Actions 固定到提交 SHA，由 Dependabot 提议更新。

### ARM64 构建故障

若日志在 `npm ci` 阶段出现 `qemu: uncaught target signal 4 (Illegal instruction)` / exit 132，崩溃发生于 QEMU 下执行 Node/npm 的阶段，不足以证明游戏代码不支持 ARM64。上游生产依赖未声明 x86 专用限制；本流水线通过原生 ARM64 构建和服务测试验证实际兼容性。GitHub 提供 [原生 ARM64 Linux runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
