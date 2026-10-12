"""출처 목록(sources.json)을 읽는다. 목록은 사람이 손으로 고치는 파일이다."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# 우리 칸 가운데 글자 칸. 서버의 줄 꼴(docs/IMPORT-FORMAT.md)과 이름이 같다.
TEXT_FIELDS = ("kind", "name", "region", "address", "subway_line", "station", "media_type", "operator")

# 가로·세로에 쓸 수 있는 단위와 m 로 바꾸는 값
UNIT_TO_M = {"mm": 0.001, "cm": 0.01, "m": 1.0}

_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")


class SourceError(ValueError):
    """출처 목록이 틀렸을 때."""


@dataclass(frozen=True)
class Source:
    id: str
    name: str
    provider: str
    landing_page: str
    download_url: str
    license: str
    base_date: str
    encoding_hint: str | None
    # 우리 글자 칸 → 대응 규칙(칸 이름 하나, 또는 const / join / compose / region_of)
    columns: dict[str, Any]
    # 규격: {"column": 칸, "unit": 단위} 또는 {"width": 칸, "height": 칸, "unit": 단위}
    # (선택) "check_column": 같은 규격을 한 칸에 적은 칸. 두 칸에서 읽은 값과 견줘 다르면 표시만 한다.
    size: dict[str, Any] | None = None
    quantity: str | None = None
    # 좌표: {"lat": 칸, "lng": 칸, "bounds": [위도 최소, 위도 최대, 경도 최소, 경도 최대]}
    coords: dict[str, Any] | None = None
    # 표시 종료일 칸(허가 자료)
    end_date: str | None = None
    # 주소가 이 글자들 가운데 하나로 시작해야 관할 안이다
    area_prefixes: tuple[str, ...] = field(default_factory=tuple)
    note: str = ""


def load_sources(path: Path) -> list[Source]:
    """출처 목록 파일을 읽어 검사한 뒤 돌려준다."""
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    sources = [_to_source(entry) for entry in document["sources"]]
    ids = [source.id for source in sources]
    if len(ids) != len(set(ids)):
        raise SourceError("출처 id 가 겹칩니다.")
    return sources


def pick_sources(sources: list[Source], only: list[str] | None) -> list[Source]:
    """--only 로 고른 출처만 남긴다. 없는 id 는 오류다."""
    if not only:
        return sources
    known = {source.id for source in sources}
    unknown = [source_id for source_id in only if source_id not in known]
    if unknown:
        raise SourceError(f"출처 목록에 없는 id: {', '.join(unknown)}")
    return [source for source in sources if source.id in only]


def needed_columns(source: Source) -> list[str]:
    """이 출처의 대응표가 가리키는 그쪽 칸 이름 전부. 머리줄에 없으면 파일 꼴이 바뀐 것이다."""
    names: list[str] = []
    for rule in source.columns.values():
        names.extend(_columns_of_rule(rule))
    if source.size:
        names.extend(str(source.size[key]) for key in ("column", "width", "height", "check_column") if key in source.size)
    if source.coords:
        names.extend([source.coords["lat"], source.coords["lng"]])
    names.extend(name for name in (source.quantity, source.end_date) if name)
    return list(dict.fromkeys(names))


def _columns_of_rule(rule: Any) -> list[str]:
    if isinstance(rule, str):
        return [rule]
    return list(rule.get("join", []))


def _to_source(entry: dict[str, Any]) -> Source:
    source = Source(
        id=entry["id"],
        name=entry["name"],
        provider=entry["provider"],
        landing_page=entry["landing_page"],
        download_url=entry["download_url"],
        license=entry["license"],
        base_date=entry.get("base_date", ""),
        encoding_hint=entry.get("encoding_hint"),
        columns=entry["columns"],
        size=entry.get("size"),
        quantity=entry.get("quantity"),
        coords=entry.get("coords"),
        end_date=entry.get("end_date"),
        area_prefixes=tuple(entry.get("area_prefixes", [])),
        note=entry.get("note", ""),
    )
    _check_source(source)
    return source


def _check_source(source: Source) -> None:
    if not _ID_PATTERN.match(source.id):
        raise SourceError(f"출처 id 는 소문자·숫자·줄표만 씁니다: {source.id}")
    if not source.license.strip():
        raise SourceError(f"{source.id}: 이용 조건을 모르는 자료는 쓰지 않습니다.")
    for name in (source.name, source.license):
        if len(name) > 200:
            raise SourceError(f"{source.id}: 이름과 이용 조건은 200자까지입니다.")
    for ours, rule in source.columns.items():
        if ours not in TEXT_FIELDS:
            raise SourceError(f"{source.id}: 우리 칸에 없는 이름 {ours}")
        _check_rule(source.id, ours, rule)
    if source.size and source.size.get("unit") not in UNIT_TO_M:
        raise SourceError(f"{source.id}: 규격의 단위는 mm·cm·m 가운데 하나입니다.")
    if source.coords and len(source.coords.get("bounds", [])) != 4:
        raise SourceError(f"{source.id}: 좌표 범위는 수 네 개입니다.")


def _check_rule(source_id: str, ours: str, rule: Any) -> None:
    if isinstance(rule, str):
        return
    kinds = {"const", "join", "compose", "region_of"}
    if not isinstance(rule, dict) or len(rule) != 1 or next(iter(rule)) not in kinds:
        raise SourceError(f"{source_id}.{ours}: 대응 규칙은 칸 이름이거나 const·join·compose·region_of 하나입니다.")
    for field_name in rule.get("compose", []):
        if field_name not in TEXT_FIELDS:
            raise SourceError(f"{source_id}.{ours}: compose 는 우리 칸 이름만 씁니다.")
