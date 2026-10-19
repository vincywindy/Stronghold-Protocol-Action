# 插件目录

由 `plugins/catalog.json` 生成。所有检索到的条目均可勾选，不按兼容性筛选。名称使用「仓库名 + 插件名」。

表中版本是检索快照；手动构建会获取来源 ref 的最新提交，并从该提交获取所选包的最新版本。实际版本和完整 SHA 见镜像 `/app/plugin-build.json`。

未勾选不添加；安装成功后仍需房主/玩家在游戏中开启。导入失败或仅部分导入不会阻止打包，原包始终保存在 `/app/plugin-sources/`。下载失败、校验失败或游戏无法启动仍会使构建失败。

| 选择键 | 显示名称 | 快照版本 | 接入方式 |
| --- | --- | --- | --- |
| `forge/ave-mujica` | Stronghold-Protocol-Forge-Mods + 颂乐人偶 | 1.1.0 | forge |
| `forge/boss-fixed-pool` | Stronghold-Protocol-Forge-Mods + 领袖固定血量（0.1.x 口径） | 1.0.0 | forge |
| `forge/capacity-panel` | Stronghold-Protocol-Forge-Mods + 房间容量看板（4/8/12/16/20 展示与预览） | 1.0.1 | forge |
| `forge/cdn-source` | Stronghold-Protocol-Forge-Mods + CDN 源选择（最快镜像） | 1.0.2 | forge |
| `forge/chat-bubble` | Stronghold-Protocol-Forge-Mods + 局内文字聊天（房内气泡） | 1.0.0 | forge |
| `forge/dmg-board` | Stronghold-Protocol-Forge-Mods + 伤害看板（结算页） | 1.0.0 | forge |
| `forge/duel-assets` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 素材容器（客户端导出 · 非商业） | 0.1.0 | forge |
| `forge/duel-copy` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 文案与不兼容清单 | 0.1.0 | forge |
| `forge/duel-data` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 规则资料（只读） | 0.1.0 | forge |
| `forge/duel-fighter` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 参战单位表（只读） | 0.1.0 | forge |
| `forge/duel-mode` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 玩法叠加层（服务端驱动） | 0.2.1 | forge |
| `forge/duel-panel` | Stronghold-Protocol-Forge-Mods + 争锋频道 · 接入状态面板（只读） | 0.1.0 | forge |
| `forge/fanpack-skillful-items` | Stronghold-Protocol-Forge-Mods + 灵巧盟约装备 | 1.0.0 | forge |
| `forge/healthz-ext` | Stronghold-Protocol-Forge-Mods + 健康与构建只读接口（/healthz 扩展 + /client-build 字段契约） | 1.0.0 | forge |
| `forge/makoto-yuki` | Stronghold-Protocol-Forge-Mods + 结城理（Persona 3 Reload） | 1.0.1 | forge |
| `forge/mod-xie` | Stronghold-Protocol-Forge-Mods + 促融共竞 · 协同共竞 | 2.1.0 | forge |
| `forge/morph-plus` | Stronghold-Protocol-Forge-Mods + 变形同构体加强mod | 1.1.0 | forge |
| `forge/name-guard` | Stronghold-Protocol-Forge-Mods + 代号审查（名字策略链） | 1.0.0 | forge |
| `forge/net-panel` | Stronghold-Protocol-Forge-Mods + 连接与服务器状态 | 1.0.0 | forge |
| `forge/notice-board` | Stronghold-Protocol-Forge-Mods + 服务器公告板（notices） | 1.0.0 | forge |
| `forge/perf-lite` | Stronghold-Protocol-Forge-Mods + 低配优化（关动画与过渡） | 1.0.0 | forge |
| `forge/prep-loadout` | Stronghold-Protocol-Forge-Mods + 休整期可更换技能和模组mod | 1.0.0 | forge |
| `forge/shop-bond-bias` | Stronghold-Protocol-Forge-Mods + 商店刷新盟约装备几率提升mod | 1.0.0 | forge |
| `forge/skin-catalogue` | Stronghold-Protocol-Forge-Mods + 时装目录（皮肤数据） | 1.0.0 | forge |
| `forge/skin-picker` | Stronghold-Protocol-Forge-Mods + 皮肤选择器（换装） | 1.0.0 | forge |
| `forge/srv-notice` | Stronghold-Protocol-Forge-Mods + 服务器公告 | 1.0.0 | forge |
| `forge/strawberry-ui` | Stronghold-Protocol-Forge-Mods + 草莓美化包（纯 CSS） | 1.0.0 | forge |
| `forge/theme-night` | Stronghold-Protocol-Forge-Mods + 夜间高对比主题 | 1.0.0 | forge |
| `forge/unequip` | Stronghold-Protocol-Forge-Mods + 装备拆卸mod | 1.1.0 | forge |
| `forge/ws-compression-reference` | Stronghold-Protocol-Forge-Mods + WS 压缩参考（协商参数 / 档位 / 实测） | 1.0.0 | forge |
| `lele/lele-damage` | Stronghold-Protocol-Lele-Mods + 伤害统计 | 0.3.3 | lele |
| `lele/lele-factions` | Stronghold-Protocol-Lele-Mods + 更多阵营 | 0.3.3 | lele |
| `lele/lele-lucky` | Stronghold-Protocol-Lele-Mods + 恭喜发财 | 0.3.3 | lele |
| `lele/lele-operators` | Stronghold-Protocol-Lele-Mods + 新干员包 | 0.3.3 | lele |
| `lele/lele-recruits` | Stronghold-Protocol-Lele-Mods + 额外干员包 | 0.3.3 | lele |
| `lele/lele-relics` | Stronghold-Protocol-Lele-Mods + 收藏品玩法 | 0.3.3 | lele |
| `lele/lele-rounds` | Stronghold-Protocol-Lele-Mods + 额外 4 回合 | 0.3.3 | lele |
| `lele/lele-targeted` | Stronghold-Protocol-Lele-Mods + 定向甄选 | 0.3.3 | lele |

## 跟踪来源

- forge: [XiaMo233M/Stronghold-Protocol-Forge-Mods](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods)，ref: `main`；[目录检索快照](https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods/tree/0dc1a4fc9db9ead85bf41258046e92065bbf6e5f)。
- lele: [llleeeqi/Stronghold-Protocol-Lele-Mods](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods)，ref: `main`；[目录检索快照](https://github.com/llleeeqi/Stronghold-Protocol-Lele-Mods/tree/90f06d473df8b5b30022623fd818f72c9c953d77)。

刷新新增插件：`node scripts/refresh-plugin-catalog.mjs`，再运行 `node scripts/generate-plugin-workflows.mjs` 并提交生成文件。GitHub 勾选框是静态配置，需要合并目录更新才会出现新条目；已有插件更新无需修改勾选框。
