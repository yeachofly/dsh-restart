# dsh-restart

给 DeepSeek Harness 加一个「重启」按钮：点一下左侧栏的 **⟳**，整个应用自动关闭并重新启动。

## 为什么需要它

DSH 的插件更新之后需要重启应用才生效，但桌面版没有提供重启入口——主进程只接受 `shutdown` / `quit-inspection` / `update-tasks` 三种 IPC 消息，**没有 restart**，插件无法请求外壳重启。这个插件补上了这个入口。

## 兼容性

- DeepSeek Harness Desktop **0.2.1-rc.2**（Windows 上验证通过）
- 其他版本与平台未验证

## 安装

```bash
dsh plugin --profile <profile> add dsh-restart
```

或把本仓库目录作为一个插件安装（`file:` 依赖），再把它加入 profile 的 `dsh.profile.bundles`：

```yaml
- insert:
    - id: dsh-restart
      name: 'dsh-restart'
```

安装后需要重启一次 DSH，图标才会出现。

## 使用

点击左侧栏面板列表里的 **⟳** 图标即可重启——单击直接执行，没有二次确认。

重启期间当前会话会中断；DSH 的会话记录是持久化的，历史不会丢。

## 工作原理

重启必须交给一个**不被 Electron 进程树连带清理**的进程，因此分两级：

1. **Stage 1**（运行在 Host 进程树内）：通过 WMI `Win32_Process.Create` 启动 Stage 2。该调用由 `WmiPrvSE.exe` 创建进程，从而脱离 Host 所在的 Job Object——实测杀掉 Host 会连带清理其所有普通子进程。
2. **Stage 2**（独立进程）：结束 Electron 外壳、结束 Host、等待外壳真正退出（单实例锁随进程退出释放），再用 `UseShellExecute` 启动应用，使新进程不依附任何控制台。

几个踩过的坑，都写在源码注释里：

- `spawn(..., { detached: true })` 会让 `powershell.exe` 启动约 70ms 后以退出码 0 结束，脚本根本不执行
- WMI 返回 `ReturnValue = 0` **不代表**进程真的跑起来了，因此 Stage 1 通过日志握手确认 Stage 2 是否启动，未启动则降级为「结束 Host，让 Electron 弹出自己的重启确认框」
- WMI 创建的是无控制台进程，PowerShell 缺少控制台句柄时会启动即退，需要 `conhost.exe --headless` 包装

## 已知限制

- 仅验证 Windows
- 依赖 WMI 可用（受限环境或组策略可能禁用）
- 如果 WMI 被禁用，会降级为「结束 Host」，此时 Electron 会弹出重启确认框，需要手动确认

## License

MIT
