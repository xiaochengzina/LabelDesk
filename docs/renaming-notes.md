# 名称与标识符现状（存档）

> 2026-10-14 记录。当时考虑过改名（与 GitHub 上已有项目重名），
> 结论是**保持现状、不改名**。这份笔记留作以后参考：万一哪天要改，
> 该动哪些地方、哪些系统状态会受影响，都已经查清。

## 当前值

| 项 | 值 | 说明 |
| --- | --- | --- |
| 产品名 `productName` | `LabelDesk` | 决定安装目录名、exe 名、开始菜单、卸载项、开机启动项名 |
| 标识符 `identifier` | `com.labeldesk.app` | 只用于 WebView2 缓存目录 |
| Cargo 包名 | `labeldesk`（lib: `labeldesk_lib`） | 决定 exe 文件名 `labeldesk.exe` |
| npm 包名 | `labeldesk` | 不发布，无影响 |

## 名称占用情况（当时查到的）

- GitHub 上 `labeldesk` 已被 `Keralots/LabelDesk` 占用（这就是当初考虑改名的原因）
- `labeldeck` 也已占用：`rongmiao926-hub/LabelDeck`、`seapagan/labeldeck`、`Tymek/labeldeck`
- crates.io 上 `labeldeck` 已占用；npm 上 `labeldeck` 未占用
- 「label/tag + 名词」这类组合基本都被占了，想改名建议用带个人色彩的命名

## 如果要改名，需要动的地方

### 纯文本替换（无风险，编译器兜底）

共约 60 处，分布在 36 个文件：

- `src-tauri/tauri.conf.json` — `productName`、`identifier`、窗口 `title`
- `src-tauri/Cargo.toml` — 包名、`[lib] name`、description、authors
- `src-tauri/src/main.rs` — `labeldesk_lib::run()`
- `src-tauri/src/*.rs` — 日志前缀 `[LabelDesk]`、`datadir.rs` 的旧目录常量
- `src/**/*.tsx|ts` — 界面标题、导出文件名前缀、打印作业名、注释
- `index.html`、`package.json`、`README.md`、`docs/**`、`scripts/**`

### 会影响机器状态的三处（必须一并处理）

1. **安装目录**：`%LOCALAPPDATA%\LabelDesk` → `%LOCALAPPDATA%\<新名>`
   → 数据目录是 exe 同级 `data\`，所以数据会跟着换位置。
   → 需要写迁移：新 `data\` 为空时，从旧安装目录的 `data\` 搬过来。
   → 好消息：数据目录**不依赖 identifier**，只有安装目录变了才需要迁移。

2. **开机启动项**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\LabelDesk`
   → 项名取自 productName，改名后新程序认不出旧项，可能自启两个实例。
   → 需要在新程序启动时删掉旧项（或提示用户去「设置」里重开一次）。

3. **卸载项**：`HKCU\...\Uninstall\LabelDesk`
   → 旧项残留会让控制面板出现两个「程序」。
   → 建议先卸载旧版再装新版。

### identifier 要不要一起改

- **不改**（推荐）：WebView2 缓存目录不变，改名影响降到最低，无需任何迁移代码。
- **改**：更干净，代价是 WebView2 重建缓存目录（多一个待清理目录，无实质损失）。

`identifier` 与显示名、安装目录、数据位置**都无关**，两者是独立的两件事。

## 改名的检查清单（照做即可）

```powershell
# 1) 全局替换（注意大小写两种写法）
#    LabelDesk → 新名（显示名、文档、日志）
#    labeldesk → 新名小写（包名、exe 名、路径）
#    labeldesk_lib → 新名_lib（Rust 库名）

# 2) 旧数据迁移：datadir.rs 里把旧安装目录加进候选来源

# 3) 清理旧开机启动项：autostart 模块里删 HKCU\...\Run\LabelDesk

# 4) 重新构建 + 实测升级安装（比对 data\ 哈希确认数据未动）
npx tauri build

# 5) 卸载旧版，避免控制面板残留两个条目
```
