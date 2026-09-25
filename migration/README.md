# `00001` 与棒材任务迁移档案

这份档案对应 WorkBuddy 对话 `00001`（会话 ID
`21624865-44ed-450b-a9b2-c650dec10933`）及 2026-09-25 的本机工作区快照。
**先读本文件，再读 [可读对话](conversation/00001_visible.md)。** 对话是历史记录，
其中的旧判断不能代替当前规则或平台反馈。

本仓库是公开的，所以只公开经过处理的用户/助手可见对话。原始 WorkBuddy JSONL
包含工具输入输出和疑似凭据，连同完整项目归档放在
[`archives/00001-jinyinsai1-20260925-final.aicenc`](archives/00001-jinyinsai1-20260925-final.aicenc)
中，以 AES-256-GCM 加密。**密钥不在 GitHub；必须单独保存和传输。**
可读对话省略工具记录、内部提示和 4 张图片，不能直接导回 WorkBuddy。

## 完整归档包含

- `jinyinsai1` 的 Git 全历史与当前 `main` 工作树；本地 `main` 为 `40ffc33`，
  另保留了本机 `origin/main` 的 `1b9f881` 引用。
- `jinyinsai1_nolimit` 的 Git 全历史与当前 `semi-final` 工作树
  `d22eee2`。这是对话后期实际工作的求解分支。
- `auto_review` 的 Git 全历史与当前工作树；自动打榜 MCP 的独立版本就在
  本 `new_mcp` 仓库中。
- 原始 `00001` 会话 JSONL、元数据、可读对话、`jinyinsai1_nolimit/runs`
  的全部 35 MiB 检查点，以及 `jinyinsai1` 中尚未入库的重要文件和
  `runs/semi_full`。
- `MANIFEST.json`：列出文件大小、SHA-256 和归档时的提交号。

主工作区 `jinyinsai1/runs` 约 860 MiB，未装入 GitHub 归档；它是搜索中间产物。
归档也不包含浏览器登录状态、Chrome profile、机器编译的 `.exe` 和无关的
`aic_new_review`、`output/pdf` 项目。现有项目源码和交付包可由 Git bundle 恢复；
大体量搜索输出需要按项目说明重新运行。

## 在新机器上解密与恢复

把密钥文件**另行**带到新机器，然后在克隆的 `new_mcp` 目录执行：

```powershell
python -m pip install -r migration/requirements.txt
python migration/tools/secure_archive.py decrypt `
  migration/archives/00001-jinyinsai1-20260925-final.aicenc `
  full-migration.zip --key-file <密钥文件的绝对路径>
Expand-Archive full-migration.zip -DestinationPath recovered
git clone recovered/repos/jinyinsai1-semi-final.bundle jinyinsai1_nolimit
git clone recovered/repos/jinyinsai1-main.bundle jinyinsai1
```

`recovered/worktrees/` 还放有各工作树的 ZIP，方便不需要 Git 历史时直接查看。
`recovered/local_changes/jinyinsai1/` 保存主工作区未入库的重要文件；
`recovered/run_state/jinyinsai1_nolimit/runs/` 保存可续跑检查点。
原始会话在 `recovered/conversation/`。将其放回 WorkBuddy 内部目录能否让新机器的
应用直接显示原对话，**尚未验证**；可读版和 JSONL 可作为接手代理的上下文。

解密后先读 `jinyinsai1_nolimit/MIGRATION.md` 与
`diagnostics/clause6_OPEN_RISK_20260923.md`。后者指出条款 6 的更严格读法仍是
未决风险；本地校验通过不足以证明平台会接受提交包。

加密文件 SHA-256：`cf663fddcbd49df4c614762b88a2605e5b086241c2d0c04de6320801d1d0b24b`。
解密所得 ZIP SHA-256：`772160f94061a0bf0a80b32063199f0765abf66492ce839ce0eff0eee16c5b0d`。
