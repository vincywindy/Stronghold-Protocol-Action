# 为 Action 提交插件

本仓库在构建时启用插件来源，在运行时通过外挂管理器检索、下载和安装插件，不以“当前能否正常游玩”作为收录条件。新增插件和适配改进均可提交 PR；请如实描述当前接入状态。

## 提交格式

在 `plugins/catalog.json` 的 `sources` 中登记来源，在 `plugins` 数组中登记插件。字段格式见 `plugins/catalog.schema.json`，完整示例见 `plugins/native-example.json`。

示例中的仓库名、全零 SHA、版本与许可是占位值，提交前替换为真实信息。构建复选框只启用已登记来源；具体插件在管理网页选择，不能从网页输入任意仓库或执行命令。

来源字段：

| 字段 | 含义 |
| --- | --- |
| source 键 | 本仓库内唯一的小写标识，如 `forge`、`lele`、`your-project` |
| `repository` | GitHub `owner/repository`，不接受任意下载主机或用户输入脚本 |
| `ref` | 刷新目录时跟踪的分支、Tag 或完整 SHA；希望随作者更新可用 `main` |
| `revision` | 本次目录检索时的完整 40 位提交 SHA，用于追溯目录快照；下载按此提交固定；再次刷新目录才解析新的提交 |

插件字段：

| 字段 | 含义 |
| --- | --- |
| `source` | 引用来源键 |
| `id` | 插件原始 ID，2–32 位小写字母、数字、连字符；与作者清单中的 ID 一致 |
| `name` | 插件展示名称；管理网页显示为“仓库名 + 插件名” |
| `version` | 检索时版本，更新目录后获取新版本 |
| `license` | 来源声明；未声明填 `NOASSERTION`，不要自行编造许可 |
| `adapter` | `native`、`forge` 或 `lele` |
| `path` | 仓库内相对路径，不含绝对路径、反斜杠、隐藏路径段或 `..` |
| `sha256` | Forge ZIP 的 SHA-256；原生目录不需要 |

最终选择键是 `source/id`。多个条目可使用相同原始 ID 但不同来源；安装目标 ID 必须唯一；跨来源冲突时整次操作失败，保留原先安装状态，不覆盖另一插件。

## 推荐的原生插件布局

```text
your-repository/
  plugins/
    my-plugin/
      plugin.json
      README.md
      LICENSE
      data/...
      assets/...
```

`plugin.json` 使用游戏上游规范。路径填 `plugins/my-plugin`，适配器填 `native`。管理器下载固定提交的目录，保存到 `/data/generations/<ID>/packages/<source>/<id>/`，并安装到同代的 `plugins/<id>/`。通过上游 `pluginsDir` 参数加载，不修改上游源码。运行上游检查和打包命令，结果作为诊断；不会执行第三方测试、安装钩子或 npm 生命周期脚本。游戏默认使用 `SP_PLUGIN_SCRIPTS=sandbox`。

尽量将署名、说明和许可放在插件目录内；Forge ZIP 原始字节完整保留，包内说明不会因导入器忽略 Markdown 而丢失。此仓库不直接收纳第三方素材。

## 现有适配器与源码隔离

- `forge`：来源提供 `mods/index.json`，`mods[]` 每项包含 `id`、`name`、`version`、`path`、`sha256`。下载固定提交中的 ZIP、校验哈希，再调用上游离线导入器。导入失败仍保留原 ZIP 与诊断，不作为拒绝收录的理由。
- `lele`：专用于 `llleeeqi/Stronghold-Protocol-Lele-Mods`。运行时获取与插件同一提交的锁文件、Git 二进制/文本补丁、随包美术和署名；验证版本、Git blob 哈希及补丁前后文件身份，在插件代目录的独立游戏副本中应用宿主补丁，并初始化 `config.economy.leleHost`。使用适配后的检查器验证插件。仍不执行作者的部署、素材生成或安装脚本。具体协议见 `plugin-manager/lele-host.mjs` 和来源仓库的 `upstream.lock.json`。
- `native`：直接安装作者清单目录，适合开发者主动适配。本体需要额外依赖或宿主修改时必须在说明中列出，不自动执行这些要求。

新增适配器请修改 `plugin-manager/download.mjs`、`installer.mjs`、`install-worker.mjs` 及必要的目录刷新逻辑，补充测试和说明。额外基础依赖如确有必要，应通过可审查的 Dockerfile 改动显式安装，不能执行 JSON 中的任意 shell 命令。管理器应维持 Node.js ES modules、原生 HTTP、Preact + HTM 技术栈，独立于游戏加载器和更新清单。

每次应用选择使用新目录，下载、路径、校验或 ID 冲突失败不能改变旧的活动目录；Forge 导入器不支持某包时记录 `bundled-only`。兼容性筛选与下载完整性检查是两回事。普通插件不能改游戏源码、管理器凭据或其他插件文件。宿主适配只能修改可丢弃的独立副本，不能改 `/app` 或 Release 更新所用的 `/data/games/` 基线；不得放宽上游插件校验来假装安装成功。管理器密码和 GitHub Token 不传入游戏/导入子进程。

宿主补丁协议变更须同时提交适配代码与测试。测试应覆盖基线不匹配、路径逃逸、符号链接、下载校验失败、旧安装迁移、多仓库混用、卸载恢复原版，以及游戏更新/回退时在停止当前进程前验证补丁。补丁和插件必须使用相同提交，不依赖可变的分支 URL；保留作者许可与来源说明。运行镜像通过 Dockerfile 显式安装 Git，仅用 `git apply` 处理已检查路径和哈希的补丁，不在构建时应用补丁。

## 更新与生成

```bash
# 检索登记来源的最新目录；只看索引和 manifest，不验证玩法。
node scripts/refresh-plugin-catalog.mjs
# 更新主工作流的仓库复选框和插件列表。
node scripts/generate-plugin-workflows.mjs
# CI 使用此命令确认生成文件没有落后。
node scripts/generate-plugin-workflows.mjs --check
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

刷新器自动发现 `mods/index.json` 中的 Forge 包，以及 `plugins/<id>/plugin.json` 形式的原生/Lele 包；其他布局需要扩展刷新器。运行中的网页也使用同一刷新逻辑，已启用仓库新增插件无需重新构建。已安装条目从来源消失后可以保留或卸载，但无法再次下载/更新。

生成器只更新 `.github/workflows/docker.yml` 的 `BEGIN/END GENERATED PLUGIN INPUTS` 区域与插件列表，不覆盖其余构建逻辑。每个来源仅生成 `plugins_<source>` 复选框，支持多仓库混用；具体插件在运行后的网页选择。GitHub 的 25 个字段上限减去 3 个构建设置，最多容纳 22 个来源，超过时生成器会报错。用完整 SHA 作为 `ref` 可以固定来源。

## PR 应包含什么

1. 来源仓库链接、插件 ID、作者、许可、目录检索提交及接入方式。
2. `plugins/catalog.json`、运行生成器得到的工作流和 `plugins/README.md`；若改接口，同步本说明与 schema。
3. 说明原包在哪里、预期复制/导入到哪里，是否有宿主补丁、脚本或额外素材流程。兼容性未知可以写“未验证”，不必伪造可用证明。
4. 附实际运行的检查结果；若验证了安装或游玩，写清版本和范围。不要把“下载打包成功”描述成“玩法验证通过”。

所有仓库复选框默认 `false`；构建时仅固化启用来源和目录，不下载、不安装第三方插件；轮询传入空来源集合；启用任意来源的手动构建要求自定义 `image_tag`；任何手动镜像都不能发布 `latest` 或自动 Release/SHA 别名。这些是所有 PR 必须保持的发布规则。
