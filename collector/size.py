"""규격 읽기. 한 칸에 적힌 "가로*세로"를 m 단위의 수 둘로 바꾼다. 못 읽으면 지어내지 않고 표시한다.

읽는 칸에 실제로 나온 꼴
  4206mm*1262mm          단위가 값에 붙어 있다
  540x100, 384X64        칸 이름이 단위(cm)를 말한다
  8X0.9, 2.6 x 0.38      m
  16.5*9    13.5*9       한 칸에 여러 면. 빈칸 여러 개나 쉼표로 잇는다
  1.5*2    높이:6        끝에 높이가 붙는다
견본으로만 시험한 꼴(읽는 칸에는 없었다)
  0.8*3.5*7.5            셋째 수는 높이(바닥에서 떨어진 높이)다. 가로·세로만 읽는다(읽지 않는 칸인 수원 "규격2"의 꼴)
  6,5*1                  쉼표가 소수점인지 알 수 없다 → 읽지 않는다
  3*4m, 5m*300           단위가 한쪽 수에만 붙었다 → 그 단위를 두 수에 함께 쓴다
  3m*400cm               두 수의 단위가 서로 다르다 → 읽지 않는다
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .sources import UNIT_TO_M

_HEIGHT_NOTE = re.compile(r",?\s*높이\s*:\s*[\d.]+\s*$")
_AROUND_SIGN = re.compile(r"\s*[*xX×]\s*")
_FACE_GAP = re.compile(r"\s*,\s+|\s+,\s*|\s+")
_PART = re.compile(r"^(\d+\.?\d*|\.\d+)(mm|cm|m)?$", re.IGNORECASE)


@dataclass(frozen=True)
class Size:
    width_m: float | None = None
    height_m: float | None = None
    # 값에도 칸 이름에도 단위가 적혀 있지 않아 출처의 기본 단위(mm·cm·m 가운데 출처 목록에 적은 것)로 봤다
    unit_assumed: bool = False
    marks: tuple[str, ...] = field(default_factory=tuple)


def parse_size(text: str | None, unit: str, unit_stated: bool) -> Size:
    """규격 한 칸을 읽는다. unit 은 값에 단위가 없을 때 쓰는 단위, unit_stated 는 그 단위가 칸 이름에 적혀 있는가."""
    body = _HEIGHT_NOTE.sub("", (text or "").strip())
    if not body:
        return Size()
    faces = [_parse_face(token, unit) for token in _FACE_GAP.split(_AROUND_SIGN.sub("*", body)) if token]
    if not faces or any(face is None for face in faces):
        return Size(marks=("size_unreadable",))
    readable = [face for face in faces if face is not None]
    return _choose(readable, unit_stated)


def size_from_columns(width_text: str | None, height_text: str | None, unit: str, unit_stated: bool) -> Size:
    """가로·세로가 두 칸으로 나뉜 자료."""
    if not (width_text or "").strip() and not (height_text or "").strip():
        return Size()
    width, height = _to_m(width_text, unit), _to_m(height_text, unit)
    if width is None or height is None:
        return Size(marks=("size_unreadable",))
    if width == 0 or height == 0:
        return Size(marks=("size_zero",))
    return Size(width, height, unit_assumed=not unit_stated)


def _parse_face(token: str, unit: str) -> tuple[float, float, bool] | None:
    """면 하나("가로*세로" 또는 "가로*세로*높이")를 (가로 m, 세로 m, 값에 단위가 있었나)로.

    단위는 면 하나에 하나다. 한쪽 수에만 붙어 있으면("3*4m") 그 단위를 두 수에 함께 쓴다.
    수마다 다른 단위가 붙어 있으면("3m*400cm") 읽지 않는다. 어느 수에도 없으면 기본 단위다.
    """
    parts = [_PART.match(part) for part in token.split("*")]
    if len(parts) not in (2, 3) or any(part is None for part in parts):
        return None
    stated = {part.group(2).lower() for part in parts if part and part.group(2)}
    if len(stated) > 1:
        return None
    face_unit = next(iter(stated), unit)
    width, height = (_scaled(part.group(1), face_unit) for part in parts[:2] if part)
    return width, height, bool(stated)


def _choose(faces: list[tuple[float, float, bool]], unit_stated: bool) -> Size:
    """면이 하나면 그것을, 여럿인데 모두 같으면 그것을 쓴다. 서로 다르면 어느 면인지 고르지 않는다."""
    sizes = {(width, height) for width, height, _ in faces}
    if any(width == 0 or height == 0 for width, height in sizes):
        return Size(marks=("size_zero",))
    if len(sizes) > 1:
        return Size(marks=("size_faces_differ",))
    width, height = next(iter(sizes))
    assumed = not unit_stated and not all(has_unit for _, _, has_unit in faces)
    return Size(width, height, assumed, ("size_faces_same",) if len(faces) > 1 else ())


def _to_m(text: str | None, unit: str) -> float | None:
    match = _PART.match((text or "").strip())
    return _scaled(match.group(1), match.group(2) or unit) if match else None


def _scaled(number: str, unit: str) -> float:
    """단위를 m 로 바꾼다. 소수 넷째 자리까지만 남긴다(4206mm → 4.206)."""
    return round(float(number) * UNIT_TO_M[unit.lower()], 4)
