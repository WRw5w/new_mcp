"""Export the visible dialogue from a WorkBuddy session without host internals.

The raw session may contain tool output, credentials and WorkBuddy metadata. This
export is for an agent to read; it is not an importable WorkBuddy session.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

CN = timezone(timedelta(hours=8))
INJECTED = re.compile(
    r"<(system-reminder|task-notification|conversation_history_summary|"
    r"identity_context|product_identity|project_context|memory|user_info|"
    r"connector-status|available_deferred_tools|personal_files_safety|"
    r"response_language)\b[^>]*>.*?</\1>", re.I | re.S,
)
SECRETS = (
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{16,})\b"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]{16,}"),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['\"]?[^\s'\";,]{8,}"),
    re.compile(r"(?i)([?&](?:token|key|secret|password|code)=)[^&#\s]+"),
)
EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")


def clean(text: str, redactions: Counter) -> str:
    text = INJECTED.sub("", text).strip()
    text = re.sub(r"</?(?:system-reminder|task-notification|conversation_history_summary)[^>]*>",
                  "", text, flags=re.I).strip()
    text = re.sub(r"</?user_query>", "", text, flags=re.I).strip()
    if text.startswith(("Use the TaskOutput tool with task_id=",
                        "Please continue with the conversation based on the summarized context")):
        return ""
    if not text:
        return ""
    for pattern in SECRETS:
        text, count = pattern.subn("[REDACTED_SECRET]", text)
        redactions["secret"] += count
    text, count = EMAIL.subn("[REDACTED_EMAIL]", text)
    redactions["email"] += count
    text, count = PHONE.subn("[REDACTED_PHONE]", text)
    redactions["phone"] += count
    return "\n".join(line.rstrip() for line in text.split("\n"))


def export(source: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    visible = []
    stats = Counter()
    redactions = Counter()
    for line in source.open(encoding="utf-8"):
        stats["source_lines"] += 1
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            stats["malformed_lines"] += 1
            continue
        role = record.get("role")
        if record.get("type") != "message" or role not in {"user", "assistant"}:
            continue
        content = record.get("content") or []
        if not isinstance(content, list):
            content = [content]
        chunks = [item.get("text", "") for item in content if isinstance(item, dict)
                  and item.get("type") in {"input_text", "output_text"}]
        text = clean("\n\n".join(chunks), redactions)
        images = sum(isinstance(item, dict) and item.get("type") == "image_blob_ref"
                     for item in content)
        if images:
            text += ("\n\n" if text else "") + f"[省略 {images} 张图片附件]"
            stats["omitted_images"] += images
        if not text:
            stats["boilerplate_only"] += 1
            continue
        when = datetime.fromtimestamp(int(record.get("timestamp", 0)) / 1000, CN)
        visible.append({"role": role, "time": when.isoformat(timespec="seconds"), "text": text})
        stats[f"{role}_messages"] += 1

    jsonl_path = out_dir / "00001_visible.jsonl"
    with jsonl_path.open("w", encoding="utf-8", newline="\n") as file:
        for message in visible:
            file.write(json.dumps(message, ensure_ascii=False) + "\n")
    md = ["# WorkBuddy 对话 00001（可读迁移版）", "",
          f"原始会话 ID：`{source.stem}`。仅保留用户与助手可见文本；工具调用、工具结果、"
          "思考、宿主注入上下文及图片附件均未导出。敏感值已脱敏。",
          "本文件供新代理阅读，不能直接导入 WorkBuddy 恢复原会话。", ""]
    for index, message in enumerate(visible, 1):
        label = "用户" if message["role"] == "user" else "助手"
        md.extend([f"## {index}. {label} · {message['time']}", "", message["text"], ""])
    (out_dir / "00001_visible.md").write_text("\n".join(md), encoding="utf-8", newline="\n")
    return {"source_session": source.stem, "stats": dict(stats),
            "redactions": dict(redactions), "visible_messages": len(visible)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("out_dir", type=Path)
    args = parser.parse_args()
    print(json.dumps(export(args.source, args.out_dir), ensure_ascii=False, indent=2))
