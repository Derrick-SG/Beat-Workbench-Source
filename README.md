# 节拍工作台 · 公开源码快照

当前版本：**V1.1.4**。这是可编辑、可本地运行和重新打包的网页工作台源码。公开演示：[打开工作台](https://derrick-sg.github.io/Beat-Workbench-Demo/#work-entry)。

## 运行与构建

需要 Node.js 22 或更新版本，无需安装 npm 依赖。

```sh
node scripts/serve.mjs
```

在电脑浏览器打开 `http://127.0.0.1:4173/`。如端口已占用，可设置 `PORT` 环境变量后重新启动。手机或其他电脑可使用上面的公开演示链接。

```sh
node scripts/build.mjs
node --test --test-isolation=none tests/*.test.mjs
```

构建输出 `dist/节拍工作台.html`，可作为单文件离线打开。[V1.1.4 分享包](dist/20261125_Beat-Workbench_V1.1.4.zip)包含该页面和使用说明。编辑请从 `src/` 开始，`scripts/` 包含本机服务与打包工具，`tests/` 是自动检查；`reference/2026-09-22/节拍工作台.html` 仅用作恢复版本的哈希校验夹具。

## 数据、Notion 与 ChatGPT

浏览器演示版的数据保存在各浏览器本地，设备之间不会自动同步。本机版可选择工作区文件夹；Notion 同步需要另外创建内部连接并在本机运行 `scripts/configure-notion.cmd`。ChatGPT 辅助日、周、月、年报告只在完整本机工程的固定 `127.0.0.1:4173` 入口启用，由用户确认发送当前范围的已保存记录；账号资格与真实授权仍需用户自行验证。公开演示及单 HTML 分享包不启用 AI 连接。凭据不会存入本仓库。请勿把实际令牌、个人工作记录或备份提交到 GitHub。

本仓库是 V1.1.4 的干净源码快照，不包含私有项目的历史提交和内部工作记录。目前未附开源许可证；公开可查看不等于授予再分发许可。
