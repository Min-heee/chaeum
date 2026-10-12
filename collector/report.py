"""보고: 정리와 보내기의 수를 표로 낸다. 수는 기록 파일에 적힌 그대로다(지어내지 않는다)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import paths
from .sources import Source

_HEADERS = ["출처", "받은 줄", "정리된 줄", "같은 줄", "같은 자리·규격", "못 읽은 줄", "인코딩", "걸린 시간(초)", "메모리 최고(MB)"]


def load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def markdown_table(headers: list[str], rows: list[list[Any]]) -> str:
    """마크다운 표. 수는 천 단위 쉼표를 넣는다."""
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines.extend("| " + " | ".join(_cell(value) for value in row) + " |" for row in rows)
    return "\n".join(lines)


def _cell(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        return "" if value is None else str(value)
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        return f"{value:,.2f}"
    return str(value)


def stats_row(stats: dict[str, Any]) -> list[Any]:
    if stats.get("failed"):
        # 정리가 실패한 출처. 지난번의 수를 내지 않는다.
        return [stats["source_id"], "정리 실패", *[None] * (len(_HEADERS) - 2)]
    encoding = stats["encoding"] + ("(짐작)" if stats["encoding_guessed"] else "")
    return [
        stats["source_id"],
        stats["rows_in"],
        stats["rows_out"],
        stats["exact_duplicates"],
        stats["key_duplicates"],
        stats["unreadable_total"],
        encoding,
        stats.get("elapsed_seconds"),
        stats.get("peak_rss_mb"),
    ]


def total_row(all_stats: list[dict[str, Any]]) -> list[Any]:
    done = [stats for stats in all_stats if not stats.get("failed")]

    def total(name: str) -> int:
        return sum(stats[name] for stats in done)

    seconds = round(sum(stats.get("elapsed_seconds") or 0 for stats in done), 2)
    names = ("rows_in", "rows_out", "exact_duplicates", "key_duplicates", "unreadable_total")
    failed = len(all_stats) - len(done)
    label = f"합계({len(done)}개)" if not failed else f"합계({len(done)}개, 정리 실패 {failed}개는 빠짐)"
    return [label, *(total(name) for name in names), "", seconds, ""]


def marks_table(all_stats: list[dict[str, Any]]) -> str:
    """표시별 줄 수. 줄 하나에 표시가 여럿 붙을 수 있다."""
    done = [stats for stats in all_stats if not stats.get("failed")]
    names = sorted({name for stats in done for name in stats["marks"]})
    rows = [[stats["source_id"], *(stats["marks"].get(name, 0) for name in names)] for stats in done]
    return markdown_table(["출처", *names], rows)


def push_table(log: dict[str, Any]) -> str:
    headers = ["출처", "요청", "보낸 줄", "서버가 받은 줄", "새 줄", "중복", "못 읽은 줄", "다시 보냄", "멈춘 까닭"]
    names = ("requests", "sent", "received", "new", "duplicate", "unreadable", "retries", "stopped")
    rows = [[source_id, *(entry.get(name) for name in names)] for source_id, entry in sorted(log.items())]
    return markdown_table(headers, rows)


def build_report(sources: list[Source], base: Path) -> str:
    """출처별 수의 표, 표시별 수의 표, (보냈다면) 보낸 결과의 표."""
    loaded = [load_json(paths.stats_file(base, source.id)) for source in sources]
    all_stats = [stats for stats in loaded if stats]
    if not all_stats:
        return "정리한 기록이 없습니다. 먼저 normalize 를 돌리세요."
    parts = [
        "## 출처별 수",
        markdown_table(_HEADERS, [*(stats_row(stats) for stats in all_stats), total_row(all_stats)]),
        "## 표시별 줄 수",
        marks_table(all_stats),
    ]
    push_log = load_json(paths.push_log_file(base))
    if push_log:
        parts.extend(["## 서버로 보낸 결과", push_table(push_log)])
    return "\n\n".join(parts)
