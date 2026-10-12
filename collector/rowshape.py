"""줄의 꼴 검사. 서버가 받는 꼴(docs/IMPORT-FORMAT.md 2절)을 수집기 쪽에서 한 번 더 본다.

서버에 보내기 전에 틀린 줄을 알아채려는 것이다. 최종 판단은 서버의 검사다.
"""

from __future__ import annotations

import json
from typing import Any

from .sources import TEXT_FIELDS

RAW_MAX_CHARS = 4000
TEXT_MAX_CHARS = 200
COLLECTOR_FLAGS = ("encoding_guessed", "unit_assumed")
# 서버의 표가 줄 번호를 4바이트 정수로 적는다. 이보다 크면 서버가 그 줄을 받지 않는다.
LINE_MAX = 2_147_483_647
_ALLOWED = {"line", "raw", "flags", "width_m", "height_m", "quantity", "lat", "lng", *TEXT_FIELDS}


def row_problems(row: dict[str, Any]) -> list[str]:
    """틀린 점을 사람 말로 모아 돌려준다. 빈 목록이면 보낼 수 있는 줄이다."""
    problems = [f"표에 없는 칸: {name}" for name in row if name not in _ALLOWED]
    if not _is_int(row.get("line")) or not 1 <= row["line"] <= LINE_MAX:
        problems.append("line 은 1 이상 2,147,483,647 이하의 정수")
    problems.extend(_raw_problems(row.get("raw")))
    problems.extend(_text_problems(row))
    problems.extend(_number_problems(row))
    if any(flag not in COLLECTOR_FLAGS for flag in row.get("flags", [])):
        problems.append("flags 에 서버가 모르는 표시")
    return problems


def raw_json_length(raw: dict[str, Any]) -> int:
    return len(json.dumps(raw, ensure_ascii=False, separators=(",", ":")))


def _raw_problems(raw: Any) -> list[str]:
    if not isinstance(raw, dict):
        return ["raw 가 없음"]
    return ["raw 가 4,000자를 넘음"] if raw_json_length(raw) > RAW_MAX_CHARS else []


def _text_problems(row: dict[str, Any]) -> list[str]:
    problems = []
    for name in TEXT_FIELDS:
        value = row.get(name)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip() or len(value) > TEXT_MAX_CHARS:
            problems.append(f"{name} 은 1~200자의 글자")
    return problems


def _number_problems(row: dict[str, Any]) -> list[str]:
    problems = []
    for name in ("width_m", "height_m"):
        value = row.get(name)
        if value is not None and not (_is_number(value) and 0 < value <= 10_000):
            problems.append(f"{name} 은 0 보다 큰 수")
    quantity = row.get("quantity")
    if quantity is not None and not (_is_int(quantity) and 0 <= quantity <= 1_000_000):
        problems.append("quantity 는 0 이상의 정수")
    for name, limit in (("lat", 90), ("lng", 180)):
        value = row.get(name)
        if value is not None and not (_is_number(value) and -limit <= value <= limit):
            problems.append(f"{name} 의 범위")
    return problems


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
