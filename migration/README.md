# 复赛迁移与历史档案

更新 2026-09-26。**先看求解器当前状态，不要先读完整 00001 对话。**
当前任务是 1 万单复赛，求解仓库为 [jinyinsai1 的 semi-final 分支](https://github.com/WRw5w/jinyinsai1/tree/semi-final)。
求解器文档入口在 [codex/semifinal-knowledge-cleanup](https://github.com/WRw5w/jinyinsai1/tree/codex/semifinal-knowledge-cleanup)；本仓整理在 `codex/migration-archive-cleanup`。两者均为独立分支，默认分支不会自动采用新入口。

## 哪份资料解决什么问题

| 资料 | 用途 |
|---|---|
| 求解器 README / docs/CURRENT.md | 当前可行性、证据边界和待实施方案；新入口在本次文档整理分支 |
| 本仓 [README](../README.md) | MCP 安装、环境变量、浏览器与结果归因 |
| [00001 可读对话 ZIP](archives/00001-visible-20260926.zip) | 已公开脱敏的历史 MD/JSONL；按需查，不自动全文加载 |
| [可读档案清单](archives/00001-visible-manifest.json) | 每份原文的路径、字节数与 SHA-256 |
| [完整加密档案](archives/00001-jinyinsai1-20260925-final.aicenc) | 原始会话、三仓 Git 历史/工作树、复赛 runs 检查点及重要未跟踪文件 |

可读 ZIP 只含原本公开的脱敏文件；原始会话仍只在加密档案中。
密钥独立保存、传输，不能写进仓库或档案摘要。本次没有更换加密档案和密钥。

## 新机器恢复顺序

1. 克隆求解仓库 `semi-final` 和本 MCP 仓库，保留新机已有未提交修改。
2. 单独取得密钥，解密至新文件、解压到空目录。
3. 从 `repos/` 恢复需要的 Git bundle；源码快照停留在 9 月 25 日，须结合后续远端提交，不能覆盖新代码。
4. 从 `run_state/jinyinsai1_nolimit/runs/` 恢复检查点；核对实际 chunks 和配置再决定是否续跑。
5. 按本仓 README 建环境和配置完整赛道 URL；首次在专用 Chrome 登录。登录状态不在迁移包中。

```powershell
python -m pip install -r migration/requirements.txt
python migration/tools/secure_archive.py decrypt migration/archives/00001-jinyinsai1-20260925-final.aicenc full-migration.zip --key-file <密钥文件绝对路径>
Expand-Archive full-migration.zip -DestinationPath recovered
git clone recovered/repos/jinyinsai1-semi-final.bundle restored_semifinal
```

加密档案 SHA-256：`cf663fddcbd49df4c614762b88a2605e5b086241c2d0c04de6320801d1d0b24b`。
解密 ZIP SHA-256：`772160f94061a0bf0a80b32063199f0765abf66492ce839ce0eff0eee16c5b0d`。
包含 main `40ffc33`、复赛 `d22eee2`、auto_review `005fc45` 的历史；元数据详见解密后的 MANIFEST.json。

## 检查点和会话的边界

- 包含复赛约 35 MiB 检查点；不含主工作区约 860 MiB 的全部 runs，也不含浏览器 profile/凭据、机器编译的 exe 或无关项目。
- 后续远端 `d597dd0` 记载迁移档案中的八岛已完成；旧对话“三岛未完成”不能直接触发重跑。以恢复文件为准。
- `worktrees/` 是历史工作树快照；`local_changes/jinyinsai1/` 是主工作区的重要未入库文件；合入前比较差异。
- 可读对话不是可导入的 WorkBuddy 会话；原始 JSONL 的 UI 导入也未验证。
- “当时 loopback 不通”是历史诊断，不能推断所有机器都不能自动化；现行默认是 debugging pipe。

只需查历史时，从仓库根解压到新的独立目录：

```powershell
python -m zipfile -t migration/archives/00001-visible-20260926.zip
python -m zipfile -e migration/archives/00001-visible-20260926.zip ../aic_visible_history_20260926
```

全部旧说明也已保存在该 ZIP。解压内容只作为历史证据，不覆盖当前 README。
