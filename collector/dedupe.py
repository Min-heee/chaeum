"""중복 열쇠. 서버의 collectDedupeKey 와 같은 글자를 내야 한다(docs/IMPORT-FORMAT.md 3절).

수집기는 이 열쇠로 같은 파일 안의 중복을 미리 뺀다. 맞고 틀림은 서버가 다시 정한다.
"""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

_SPACES = re.compile(r"\s+")


def key_text(value: str | None) -> str:
    """글자 조각: NFKC 로 맞추고 소문자로 바꾼 뒤 빈칸을 전부 뗀다."""
    return _SPACES.sub("", unicodedata.normalize("NFKC", value or "").lower())


def key_number(value: float | None) -> str:
    """수 조각: 소수 둘째 자리로 반올림한다. 파이썬의 round 는 짝수 쪽으로 가므로 쓰지 않는다."""
    if value is None:
        return ""
    rounded = math.floor(value * 100 + 0.5) / 100
    return str(int(rounded)) if rounded == int(rounded) else repr(rounded)


def dedupe_key(row: dict[str, Any]) -> str:
    """위치(주소, 없으면 지역) | 호선 | 역 | 매체 종류 | 가로 | 세로 | 이름(위치·역이 모두 비었을 때만)"""
    place = key_text(row.get("address")) or key_text(row.get("region"))
    station = key_text(row.get("station"))
    name = key_text(row.get("name")) if not place and not station else ""
    pieces = [
        place,
        key_text(row.get("subway_line")),
        station,
        key_text(row.get("media_type")),
        key_number(row.get("width_m")),
        key_number(row.get("height_m")),
        name,
    ]
    return "|".join(pieces)
