# LabelDesk 0.0.1

Windows 标签设计与热敏打印工具。个人自用程序，仅供参考。

## 下载

| 文件 | 大小 | 适用 |
| --- | --- | --- |
| `LabelDesk_0.0.1_x64-setup.exe` | 1.31 MB | **推荐**：NSIS 安装程序（中文/英文） |
| `LabelDesk_0.0.1_x64_en-US.msi` | 1.92 MB | 需要用 MSI 部署时选它 |

校验和（SHA256）：

```
D95C6D2D54FDF2597C1A64C037CDD950C96473016C5AEDDABC8D29EA8336DF93  LabelDesk_0.0.1_x64-setup.exe
7F059AB28DE2E6407F430648A5C60FDFE84F3CA12EC131348F7DA307EFE6FD84  LabelDesk_0.0.1_x64_en-US.msi
```

## 安装说明

- **per-user 安装，不需要管理员权限、不弹 UAC**，装到 `%LOCALAPPDATA%\LabelDesk`
- 数据（模板与配置）在 `<安装目录>\data\`，**卸载不会删除**，重装后模板还在
- 需要 WebView2 Runtime（Win11 自带；Win10 多数已随 Edge 安装）

## 本版要点

**速打小窗**：顶置无边框小窗，只留模板、粘贴框和打印按钮。在表格里 `Ctrl+C` 一行 → 小窗 `Ctrl+V` → `Enter` 出纸，不用在表格和打印窗口之间来回切。

- 拖动：按住顶部那条任意处
- 关闭：与关闭完整窗口一致，**销毁界面释放内存**，程序留在托盘
- 记住窗口形态：上次用小窗，下次打开（含完全退出后重开）直接回到小窗

**托盘驻留 + 开机启动**：关闭窗口只销毁界面，进程与托盘保留；默认开机自启，可在「设置」里关。

**数据统一放安装目录** `data\`，设置页可「打开目录 / 备份到…」，也可从旧位置（`%APPDATA%\com.labeldesk.app`）自动迁移。

## 从 0.1.0 升级

直接运行新安装包覆盖即可，**用户数据不会被改动**（实测 config 与模板哈希前后一致）。

## 已知限制

- 仅在 **Deli DL-888D**（203dpi，TSPL）上做过真机验证；ESC/POS 与 ZPL 只做了指令流结构测试
- QR 二维码版本 > 6 不可用（数据区编码有未定位的 bug，已按纠错等级收敛容量并告警）
- 仅 Windows，无自动更新、无遥测
- 用前请**少量标签纸试打**确认效果

---

完整说明见 [README](https://github.com/xiaochengzina/LabelDesk#readme)。
