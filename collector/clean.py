"""값 하나를 다듬는 작은 함수들. 파일도 시계도 쓰지 않는다(오늘 날짜는 인자로 받는다)."""

from __future__ import annotations

import re
import unicodedata
from datetime import date

# 서버가 받는 글자 칸의 길이
TEXT_MAX = 200

_SPACES = re.compile(r"\s+")
_NUMBER = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)$")
_LINE_DIGITS = re.compile(r"^[1-9]\d*(\s*,\s*[1-9]\d*)*$")
_STATION_TAIL = re.compile(r"\s*\(\d+(\s*,\s*\d+)*\)$")
# 값이 없다는 뜻으로 적어 둔 자리표시. 줄표·점만 있거나 "해당없음" 같은 말.
_PLACEHOLDER = re.compile(r"^(?:[-‐-―−.·]+|해당\s?없음|없음)$")
# 주소 앞머리에 줄여 적는 특별시·광역시 이름. "서울 강남구" 의 "서울".
_SHORT_CITIES = ("서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종")
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_REGION_ENDINGS = ("도", "시", "군", "구")

# 표 계산 프로그램이 수식으로 읽는 첫 글자
_FORMULA_STARTS = ("=", "+", "@")


def clean_text(value: str | None) -> str | None:
    """글자 칸 다듬기. 유니코드 꼴을 맞추고(㈜ → (주)), 앞뒤 공백·탭을 떼고, 이어진 빈칸을 하나로 줄인다.

    빈 값은 None 이다(서버는 빈 글자를 받지 않는다). 빈칸 자리표시("-", ".", "해당없음")만 든 값도 None 이다.
    자리표시를 값으로 두면 주소가 "-" 인 줄끼리 같은 자리로 합쳐진다. 원래 값은 raw 에 그대로 남는다.
    """
    if value is None:
        return None
    text = _SPACES.sub(" ", unicodedata.normalize("NFKC", value)).strip()
    if not text or _PLACEHOLDER.match(text):
        return None
    return text


def parse_number(value: str | None) -> float | None:
    """수로 읽히면 수, 아니면 None. "생략" 같은 글이나 "2,5" 는 읽지 않는다."""
    text = (value or "").strip()
    return float(text) if _NUMBER.match(text) else None


def normalize_line(value: str | None) -> str | None:
    """호선: "1" → "1호선", "1,2" → "1,2호선". 이미 "1호선" 이면 그대로. "0" 같은 값은 호선으로 고치지 않고 그대로 둔다."""
    text = clean_text(value)
    if text is None:
        return None
    if _LINE_DIGITS.match(text):
        return _SPACES.sub("", text) + "호선"
    return text


def normalize_station(value: str | None) -> str | None:
    """역: "서울역(1)" → "서울역", "강남(2)" → "강남역", "시청역(1,2)" → "시청역". 끝의 호선 괄호를 떼고 "역" 으로 끝나게 한다.

    역 이름인지는 판단하지 않는다. 역 칸에 "본사" 가 적혀 있으면 "본사역" 이 된다(알려진 한계).
    """
    text = clean_text(value)
    if text is None:
        return None
    text = _STATION_TAIL.sub("", text)
    return text if text.endswith("역") else text + "역"


def region_of_address(address: str | None) -> str | None:
    """주소 앞머리의 시·도·군·구까지를 지역으로 읽는다. 주소가 그렇게 시작하지 않으면 None(지어내지 않는다).

    첫 낱말은 줄여 적은 특별시·광역시 이름("서울", "대구")도 받는다. 줄인 이름만 있고 뒤가 없으면("서울") 지역으로 읽지 않는다.
    """
    parts: list[str] = []
    for token in (address or "").split():
        is_region = token.endswith(_REGION_ENDINGS) or (not parts and token in _SHORT_CITIES)
        if not is_region or len(parts) == 3:
            break
        parts.append(token)
    if len(parts) == 1 and parts[0] in _SHORT_CITIES:
        return None
    return " ".join(parts) or None


def read_quantity(value: str | None) -> tuple[int | None, str | None]:
    """수량과 표시. 0 은 0 으로 두고 표시한다. 소수(15.5)와 글은 비우고 표시한다. 빈칸은 표시 없이 비운다."""
    if not (value or "").strip():
        return None, None
    number = parse_number(value)
    if number is None or number < 0:
        return None, "quantity_unreadable"
    if number != int(number):
        return None, "quantity_not_integer"
    return int(number), "quantity_zero" if number == 0 else None


def read_coords(
    lat_text: str | None, lng_text: str | None, bounds: tuple[float, float, float, float]
) -> tuple[float | None, float | None, str | None]:
    """좌표와 표시. 믿을 수 없으면 둘 다 비우고 까닭을 표시한다.

    bounds 는 (위도 최소, 위도 최대, 경도 최소, 경도 최대). 넉넉히 그린 네모이지 행정 경계가 아니다.
    """
    if not (lat_text or "").strip() and not (lng_text or "").strip():
        return None, None, None
    lat, lng = parse_number(lat_text), parse_number(lng_text)
    if lat is None or lng is None:
        return None, None, "coord_not_number"
    if lat == 0 or lng == 0:
        return None, None, "coord_zero"
    if _is_sample(lat_text) or _is_sample(lng_text):
        return None, None, "coord_sample"
    lat_min, lat_max, lng_min, lng_max = bounds
    if not (lat_min <= lat <= lat_max and lng_min <= lng <= lng_max):
        return None, None, "coord_out_of_area"
    return lat, lng, None


def _is_sample(text: str | None) -> bool:
    """소수 자리가 123456 으로 시작하는 값은 양식의 견본 값이다(35.123456)."""
    return (text or "").strip().partition(".")[2].startswith("123456")


def read_end_date(value: str | None, today: date) -> str | None:
    """표시 종료일의 표시. 9999-12-31 은 "기한 없음"이고, 오늘보다 앞이면 기한이 지난 것이다."""
    text = (value or "").strip()
    if not text:
        return None
    match = _DATE.match(text)
    if not match:
        return "end_date_unreadable"
    year, month, day = (int(part) for part in match.groups())
    if year == 9999:
        return "end_date_open"
    try:
        return "end_date_passed" if date(year, month, day) < today else None
    except ValueError:
        return "end_date_unreadable"


def looks_like_formula(value: str | None) -> bool:
    """=, +, @ 로 시작하는 칸. 값은 고치지 않는다(표시만 한다). 숫자로 읽히는 "+3" 은 아니다."""
    text = (value or "").lstrip()
    return text.startswith(_FORMULA_STARTS) and parse_number(text) is None


def clip_text(text: str | None) -> tuple[str | None, bool]:
    """200자를 넘으면 잘라 내고 잘랐다고 알린다."""
    if text is None or len(text) <= TEXT_MAX:
        return text, False
    return text[:TEXT_MAX].rstrip(), True
