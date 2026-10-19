# 为 Action 提交插件

本仓库负责检索、下载和打包插件，不以“当前能否正常游玩”作为收录条件。新增插件和适配改进均可提交 PR；请如实描述当前接入状态。

## 提交格式

在 `plugins/catalog.json` 的 `sources` 中登记来源，在 `plugins` 数组中登记插件。字段格式见 `plugins/catalog.schema.json`，完整示例见 `plugins/native-example.json`。

示例中的仓库名、全零 SHA、版本与许可是占位值，提交前替换为真实信息。构建输入框只接受已登记的选择键，不能直接输入任意仓库地址。

来源字段：

| 字段 | 含义 |
| --- | --- |
| source 键 | 本仓库内唯一的小写标识，如 `forge`、`lele`、`your-project` |
| `repository` | GitHub `owner/repository`，不接受任意下载主机或用户输入脚本 |
| `ref` | 构建时跟踪的分支、Tag 或完整 SHA；希望随作者更新可用 `main` |
| `revision` | 本次目录检索时的完整 40 位提交 SHA，用于追溯目录快照；不是构建锁定值 |

插件字段：

| 字段 | 含义 |
| --- | --- |
| `source` | 引用来源键 |
| `id` | 插件原始 ID，2–32 位小写字母、数字、连字符；与作者清单中的 ID 一致 |
| `name` | 插件展示名称；工作流自动显示为“仓库名 + 插件名” |
| `version` | 检索时版本，构建时以实际原包/清单为准 |
| `license` | 来源声明；未声明填 `NOASSERTION`，不要自行编造许可 |
| `adapter` | `native`、`forge` 或 `lele` |
| `path` | 仓库内相对路径，不含绝对路径、反斜杠、隐藏路径段或 `..` |
| `sha256` | Forge ZIP 的 SHA-256；原生目录不需要 |

最终选择键是 `source/id`。多个条目可使用相同原始 ID 但不同来源；原包分别保存，安装目标发生冲突时记录诊断并保留原包，不覆盖另一插件。

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

`plugin.json` 使用游戏上游规范。路径填 `plugins/my-plugin`，适配器填 `native`。Action 会将此目录完整保存到 `/app/plugin-sources/<source>/<id>/plugin/`，并复制到 `/app/plugins/<id>/`；尝试游戏自带的检查和打包命令，结果只作为诊断。不会执行插件的测试脚本、安装钩子，也不会自动开启游戏脚本执行模式。

尽量将署名、说明和许可放在插件目录内；Forge ZIP 的原始字节完整保留，因此包内说明不会因导入器忽略 Markdown 而丢失。此仓库不直接收纳第三方素材。

## 现有适配器

- `forge`：来源须提供 `mods/index.json`，其 `mods[]` 每项包含 `id`、`name`、`version`、`path`、`sha256`。构建时从同一次解析的提交读取索引，定位所选 ID，校验 ZIP，再调用游戏 `import-forge`。部分导入或失败保留原 ZIP 和报告，不作为拒绝收录或打包的理由。导入使用 `--offline`，不隐式下载额外的官方数据表。
- `lele`：专用于 `llleeeqi/Stronghold-Protocol-Lele-Mods`。读取作者的 `upstream.lock.json`，基线匹配时尝试宿主补丁；不匹配保留原包并记录原因。仅复制选定的插件，共享宿主代码和资料作为该适配器的公共依赖保存。素材可选，功能是否可用由插件作者负责。
- `native`：不修改游戏本体，直接复制作者清单目录。适合开发者主动适配本 Action。

若需要新适配器，请修改 `scripts/prepare-plugins.mjs` 并补充测试及说明。不能在 JSON 中塞任意 shell 命令，不能将任意网络地址交给 `eval` 或 shell。路径/文件完整性检查属于打包正确性，不是玩法兼容性筛选。

## 更新与生成

```bash
# 检索登记来源的最新目录；只看索引和 manifest，不验证玩法。
node scripts/refresh-plugin-catalog.mjs
# 更新主工作流的仓库复选框、filter 和插件列表。
node scripts/generate-plugin-workflows.mjs
# CI 使用此命令确认生成文件没有落后。
node scripts/generate-plugin-workflows.mjs --check
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

刷新器自动发现 `mods/index.json` 中的 Forge 包，以及 `plugins/<id>/plugin.json` 形式的原生/Lele 包；其他目录布局可手工维护 `catalog.json`。来源索引条目被删除后，仍选择旧条目会明确报“无法检索”，不会生成缺少所选原包的成功镜像。

已有条目每次构建都按 `ref` 获取最新内容。新增条目需要合并目录后才能被 filter 选中。生成器只更新 `.github/workflows/docker.yml` 的 `BEGIN/END GENERATED PLUGIN INPUTS` 区域与插件列表，不覆盖其余构建逻辑。每个来源自动生成 `plugins_<source>` 复选框和 `<source>_filter` 文本框，全部放在主构建入口，支持多个仓库混用。不要新增分仓库工作流；GitHub 的 25 个字段上限减去 3 个构建设置后，最多容纳 11 个来源，超过时生成器会报错，需先调整入口设计。用完整 SHA 作为 `ref` 可以固定来源；本次实际提交、版本及包校验值会写入镜像清单，两个架构共用同一准备产物。

filter 对插件 ID、名称、`source/id` 做不区分大小写的字面子串匹配。词之间用中英文逗号或空白分隔：普通词取并集，`!词` 排除且始终优先；留空或仅含排除词时从该仓库全部条目开始筛选。不支持正则或通配符，单独 `!` 报错。未勾选来源的 filter 忽略；已勾选来源零匹配报错，不能静默退回原版镜像。新增来源和适配器必须沿用这些规则。

## PR 应包含什么

1. 来源仓库链接、插件 ID、作者、许可、目录检索提交及接入方式。
2. `plugins/catalog.json`、运行生成器得到的工作流和 `plugins/README.md`；若改接口，同步本说明与 schema。
3. 说明原包在哪里、预期复制/导入到哪里，是否有宿主补丁、脚本或额外素材流程。兼容性未知可以写“未验证”，不必伪造可用证明。
4. 附实际运行的检查结果；若验证了安装或游玩，写清版本和范围。不要把“下载打包成功”描述成“玩法验证通过”。

所有仓库复选框默认 `false`，filter 默认空字符串；勾选且 filter 留空时选择该仓库全部已收录插件；轮询传入空插件集合；含插件的手动构建要求自定义 `image_tag`；任何手动镜像都不能发布 `latest` 或自动 Release/SHA 别名。这些是所有 PR 必须保持的发布规则。
