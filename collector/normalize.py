"""정리: 받은 CSV 한 파일을 서버가 받는 꼴의 줄(JSON Lines)로 바꾼다.

하는 일: 인코딩 판별 → CSV 읽기 → 칸 이름 맞추기 → 값 다듬기 → 의심 표시 → 중복 빼기 → 파일로 쓰기.
하지 않는 일: 값이 맞는지 정하기(서버가 한다), 없는 값 채우기(가격·좌표를 지어내지 않는다).
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, TextIO

from . import clean
from .dedupe import dedupe_key
from .rowshape import RAW_MAX_CHARS, raw_json_length
from .size import Size, parse_size, size_from_columns
from .sources import TEXT_FIELDS, Source, needed_columns
from .textio import count_lines, detect_encoding, read_records

# 합계 줄의 첫 칸에 오는 말
_TOTAL_WORDS = ("합계", "총계", "소계", "계")


class LayoutChanged(ValueError):
    """머리줄에 대응표가 가리키는 칸이 없거나 같은 칸 이름이 둘이다. 기관이 파일 꼴을 바꾼 것이다."""


class BrokenQuotes(ValueError):
    """칸 수가 안 맞는 줄의 칸에 줄바꿈이 들어 있다. 따옴표가 잘못 열려 뒤의 줄들을 한 칸으로 삼킨 것으로 본다."""


@dataclass
class Stats:
    """출처 하나를 정리한 수. report 가 이 수를 그대로 낸다."""

    source_id: str
    encoding: str = ""
    encoding_guessed: bool = False
    # 파일의 줄 수(머리줄 포함). 읽은 줄 수(rows_in)보다 많으면 따옴표 안에 줄바꿈이 든 칸이 있다는 뜻이다.
    file_lines: int = 0
    rows_in: int = 0
    rows_out: int = 0
    exact_duplicates: int = 0
    key_duplicates: int = 0
    unreadable: Counter[str] = field(default_factory=Counter)
    marks: Counter[str] = field(default_factory=Counter)

    @property
    def unreadable_total(self) -> int:
        return sum(self.unreadable.values())

    def to_json(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "encoding": self.encoding,
            "encoding_guessed": self.encoding_guessed,
            "file_lines": self.file_lines,
            "rows_in": self.rows_in,
            "rows_out": self.rows_out,
            "exact_duplicates": self.exact_duplicates,
            "key_duplicates": self.key_duplicates,
            "unreadable": dict(sorted(self.unreadable.items())),
            "unreadable_total": self.unreadable_total,
            "marks": dict(sorted(self.marks.items())),
        }


# ── 줄 하나 ────────────────────────────────────────────────


def unreadable_reason(header: list[str], cells: list[str]) -> str | None:
    """이 줄을 읽을 수 없는 까닭. 읽을 수 있으면 None.

    - 칸 수가 머리줄과 다르면(모자라도 남아도) 읽지 않는다.
    - 첫 칸이 합계 말이면 다른 칸이 얼마나 찼든 합계 줄이다(자료 줄로 넣으면 "전체 3개" 같은 줄이 지면 하나가 된다).
    - 머리줄과 똑같은 줄이 자료 가운데 또 나오면 되풀이된 머리줄이다.
    """
    if not any(cell.strip() for cell in cells):
        return "blank_line"
    if len(cells) != len(header):
        return "column_count"
    if cells[0].strip() in _TOTAL_WORDS:
        return "total_line"
    if [cell.strip() for cell in cells] == header:
        return "repeated_header"
    return None


def build_row(source: Source, line: int, record: dict[str, str], today: date) -> tuple[dict[str, Any], list[str]]:
    """원래 줄 하나를 우리 꼴의 줄과 표시 목록으로 바꾼다. 없는 값의 칸은 넣지 않는다."""
    row: dict[str, Any] = {"line": line}
    marks: list[str] = []
    _fill_texts(source, record, row, marks)
    _fill_size(source, record, row, marks)
    _fill_quantity(source, record, row, marks)
    _fill_coords(source, record, row, marks)
    _mark_dates_and_area(source, record, row, marks, today)
    if any(clean.looks_like_formula(cell) for cell in record.values()):
        marks.append("formula_like")
    row["raw"] = dict(record)
    return row, marks


def _fill_texts(source: Source, record: dict[str, str], row: dict[str, Any], marks: list[str]) -> None:
    """글자 칸. 그쪽 칸을 읽는 규칙을 먼저 풀고, 우리 칸을 이어 만드는 규칙(compose)을 나중에 푼다."""
    values = {name: _resolve(rule, record) for name, rule in source.columns.items() if not _is_late(rule)}
    values["subway_line"] = clean.normalize_line(values.get("subway_line"))
    values["station"] = clean.normalize_station(values.get("station"))
    for name, rule in source.columns.items():
        if _is_late(rule):
            values[name] = _resolve_late(rule, values)
    for name in TEXT_FIELDS:
        text, clipped = clean.clip_text(values.get(name))
        if clipped:
            marks.append("text_truncated")
        if text is not None:
            row[name] = text


def _is_late(rule: Any) -> bool:
    return isinstance(rule, dict) and ("compose" in rule or "region_of" in rule)


def _resolve(rule: Any, record: dict[str, str]) -> str | None:
    """칸 이름 하나 / const(정해 둔 글) / join(그쪽 칸 여럿을 빈칸으로 잇기)"""
    if isinstance(rule, str):
        return clean.clean_text(record.get(rule))
    if "const" in rule:
        return clean.clean_text(rule["const"])
    parts = [clean.clean_text(record.get(column)) for column in rule["join"]]
    return " ".join(part for part in parts if part) or None


def _resolve_late(rule: dict[str, Any], values: dict[str, str | None]) -> str | None:
    """compose(이미 다듬은 우리 칸을 잇기) / region_of(주소 앞머리에서 지역 읽기)"""
    if "region_of" in rule:
        return clean.region_of_address(values.get(rule["region_of"]))
    parts = [values.get(name) for name in rule["compose"]]
    return " ".join(part for part in parts if part) or None


def _read_size(source: Source, record: dict[str, str]) -> Size:
    spec = source.size or {}
    stated = bool(spec.get("unit_stated", False))
    if "column" in spec:
        return parse_size(record.get(spec["column"]), spec["unit"], stated)
    if "width" in spec:
        return size_from_columns(record.get(spec["width"]), record.get(spec["height"]), spec["unit"], stated)
    return Size()


def _check_size(source: Source, record: dict[str, str], size: Size) -> str | None:
    """가로·세로를 두 칸에서 읽는 출처에 같은 규격을 한 칸에 적은 칸(check_column)도 있으면 둘을 견준다.

    - size_mismatch: 두 칸에서 읽은 값과 한 칸에서 읽은 값이 다르다(어느 쪽이 맞는지는 정하지 않는다. 값은 두 칸의 것 그대로다).
    - size_in_other_column: 두 칸으로는 못 읽었는데(0 이거나 글자) 한 칸에는 읽히는 값이 있다. 그 값으로 채우지는 않는다.
    견줄 칸이 비었거나 읽히지 않으면 표시하지 않는다.
    """
    spec = source.size or {}
    if "check_column" not in spec:
        return None
    other = parse_size(record.get(spec["check_column"]), spec["unit"], True)
    if other.width_m is None or other.height_m is None:
        return None
    if size.width_m is None or size.height_m is None:
        return "size_in_other_column"
    same = abs(size.width_m - other.width_m) < 0.005 and abs(size.height_m - other.height_m) < 0.005
    return None if same else "size_mismatch"


def _fill_size(source: Source, record: dict[str, str], row: dict[str, Any], marks: list[str]) -> None:
    size = _read_size(source, record)
    marks.extend(size.marks)
    check = _check_size(source, record, size)
    if check:
        marks.append(check)
    if size.width_m is None or size.height_m is None:
        return
    row["width_m"], row["height_m"] = size.width_m, size.height_m
    if size.unit_assumed:
        marks.append("unit_assumed")


def _fill_quantity(source: Source, record: dict[str, str], row: dict[str, Any], marks: list[str]) -> None:
    if not source.quantity:
        return
    quantity, mark = clean.read_quantity(record.get(source.quantity))
    if quantity is not None:
        row["quantity"] = quantity
    if mark:
        marks.append(mark)


def _fill_coords(source: Source, record: dict[str, str], row: dict[str, Any], marks: list[str]) -> None:
    spec = source.coords
    if not spec:
        return
    lat, lng, mark = clean.read_coords(record.get(spec["lat"]), record.get(spec["lng"]), tuple(spec["bounds"]))
    if lat is not None and lng is not None:
        row["lat"], row["lng"] = lat, lng
    if mark:
        marks.append(mark)


def _mark_dates_and_area(
    source: Source, record: dict[str, str], row: dict[str, Any], marks: list[str], today: date
) -> None:
    if source.end_date:
        mark = clean.read_end_date(record.get(source.end_date), today)
        if mark:
            marks.append(mark)
    address = row.get("address")
    if source.area_prefixes and address and not address.startswith(source.area_prefixes):
        marks.append("address_outside_area")


# ── 파일 하나 ──────────────────────────────────────────────


def _digest(text: str) -> bytes:
    """중복을 가르는 데 쓰는 짧은 지문. 글 전체를 들고 있지 않으려는 것이다."""
    return hashlib.blake2b(text.encode("utf-8"), digest_size=16).digest()


def _cleaned_line_digest(cells: list[str]) -> bytes:
    """완전히 같은 줄인지 보는 지문. 앞뒤 공백·탭만 다른 줄은 같은 줄로 본다."""
    return _digest("\x1f".join(clean.clean_text(cell) or "" for cell in cells))


def check_header(source: Source, header: list[str]) -> None:
    missing = [name for name in needed_columns(source) if name not in header]
    if missing:
        raise LayoutChanged(f"{source.id}: 머리줄에 없는 칸 {missing}. 파일 꼴이 바뀌었는지 확인하세요.")
    # 같은 이름의 칸이 둘이면 뒤 칸이 앞 칸을 덮어 값이 조용히 사라진다. 어느 칸인지 사람이 정해야 한다.
    twice = sorted({name for name in header if name and header.count(name) > 1})
    if twice:
        raise LayoutChanged(f"{source.id}: 머리줄에 같은 칸 이름이 둘 이상 있습니다 {twice}. 어느 칸을 읽을지 정할 수 없습니다.")


def normalize_records(
    source: Source,
    records: Iterable[list[str]],
    today: date,
    encoding_guessed: bool,
    stats: Stats,
    skipped: list[dict[str, Any]] | None = None,
) -> Iterator[tuple[dict[str, Any], list[str]]]:
    """줄들을 받아 (정리된 줄, 표시 목록)을 하나씩 낸다. 읽지 못한 줄과 중복은 수만 세고 내지 않는다.

    skipped 를 주면 읽지 못한 줄의 번호와 까닭을 거기에 적는다(사람이 원본에서 찾아갈 수 있게).
    """
    iterator = iter(records)
    header = [name.strip() for name in next(iterator, [])]
    check_header(source, header)
    seen_lines: set[bytes] = set()
    seen_keys: set[bytes] = set()
    for line, cells in enumerate(iterator, start=1):
        stats.rows_in += 1
        result = _one_record(source, header, line, cells, today, seen_lines, seen_keys, stats, skipped)
        if result is None:
            continue
        row, marks = result
        if encoding_guessed:
            marks.append("encoding_guessed")
        _attach_flags(row, marks)
        stats.rows_out += 1
        stats.marks.update(marks)
        yield row, marks


def _one_record(
    source: Source,
    header: list[str],
    line: int,
    cells: list[str],
    today: date,
    seen_lines: set[bytes],
    seen_keys: set[bytes],
    stats: Stats,
    skipped: list[dict[str, Any]] | None,
) -> tuple[dict[str, Any], list[str]] | None:
    reason = unreadable_reason(header, cells)
    if reason == "column_count" and any("\n" in cell or "\r" in cell for cell in cells):
        raise BrokenQuotes(
            f"{source.id}: 자료 {line}번째 줄의 칸 수가 머리줄과 다르고 칸 안에 줄바꿈이 있습니다. "
            "따옴표가 닫히지 않아 뒤의 줄들이 한 칸으로 읽힌 것 같습니다. 원본을 확인하세요."
        )
    if reason:
        _skip(stats, skipped, line, reason)
        return None
    if _seen_before(seen_lines, _cleaned_line_digest(cells)):
        stats.exact_duplicates += 1
        return None
    row, marks = build_row(source, line, dict(zip(header, cells, strict=True)), today)
    if raw_json_length(row["raw"]) > RAW_MAX_CHARS:
        _skip(stats, skipped, line, "raw_too_long")
        return None
    key = dedupe_key(row)
    if key.strip("|") and _seen_before(seen_keys, _digest(key)):
        stats.key_duplicates += 1
        return None
    return row, marks


def _skip(stats: Stats, skipped: list[dict[str, Any]] | None, line: int, reason: str) -> None:
    stats.unreadable[reason] += 1
    if skipped is not None:
        skipped.append({"line": line, "reason": reason})


def _seen_before(seen: set[bytes], digest: bytes) -> bool:
    if digest in seen:
        return True
    seen.add(digest)
    return False


def _attach_flags(row: dict[str, Any], marks: list[str]) -> None:
    """서버가 아는 표시 둘만 줄에 싣는다. 나머지 표시는 수집기의 곁 파일에만 남는다."""
    flags = [mark for mark in ("encoding_guessed", "unit_assumed") if mark in marks]
    if flags:
        row["flags"] = flags


def normalize_file(
    source: Source, raw_path: Path, rows_out: TextIO, marks_out: TextIO, today: date, unreadable_out: TextIO | None = None
) -> Stats:
    """파일 하나를 정리해 파일들에 쓴다. rows_out 의 한 줄이 서버에 보내는 줄 하나다.

    unreadable_out 을 주면 읽지 못한 줄의 번호(머리줄 다음이 1)와 까닭을 한 줄씩 적는다.
    """
    codec, guessed = detect_encoding(raw_path, source.encoding_hint)
    stats = Stats(source.id, encoding=codec, encoding_guessed=guessed, file_lines=count_lines(raw_path))
    skipped: list[dict[str, Any]] = []
    for row, marks in normalize_records(source, read_records(raw_path, codec), today, guessed, stats, skipped):
        rows_out.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        if marks:
            marks_out.write(json.dumps({"line": row["line"], "marks": marks}, ensure_ascii=False) + "\n")
        _flush_skipped(skipped, unreadable_out)
    _flush_skipped(skipped, unreadable_out)
    return stats


def _flush_skipped(skipped: list[dict[str, Any]], out: TextIO | None) -> None:
    """모아 둔 "읽지 못한 줄"을 파일에 쓰고 비운다(큰 파일에서 메모리에 쌓아 두지 않는다)."""
    if out is not None:
        for entry in skipped:
            out.write(json.dumps(entry, ensure_ascii=False) + "\n")
    skipped.clear()
