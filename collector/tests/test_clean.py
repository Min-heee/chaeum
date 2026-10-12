"""값 다듬기: 공백·탭, 호선, 역, 좌표, 수량, 날짜, 수식처럼 보이는 칸."""

from datetime import date

import pytest

from collector import clean

BOX = (35.0, 36.0, 127.0, 128.0)
TODAY = date(2026, 10, 12)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("\tJPG+MP4", "JPG+MP4"),
        (" 모악로 4746", "모악로 4746"),
        ("동부대로 680 ", "동부대로 680"),
        ("대구  북구\t침산로", "대구 북구 침산로"),
        ("㈜가상애드", "(주)가상애드"),
        ("", None),
        ("   ", None),
        (None, None),
        # 빈칸 자리표시만 든 값은 없는 값이다. 글 속의 줄표는 그대로 둔다.
        ("-", None),
        (" - ", None),
        ("--", None),
        (".", None),
        ("해당없음", None),
        ("해당 없음", None),
        ("없음", None),
        ("- 벽면이용간판(가로형)", "- 벽면이용간판(가로형)"),
        ("인계동 1009-2", "인계동 1009-2"),
        ("없음직한 이름", "없음직한 이름"),
    ],
)
def test_clean_text(raw: str | None, expected: str | None) -> None:
    assert clean.clean_text(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("12.8", 12.8), (" 35.97356000 ", 35.97356), ("9.", 9.0), (".2", 0.2), ("생략", None), ("2,5", None), ("", None), ("1e3", None)],
)
def test_parse_number(raw: str, expected: float | None) -> None:
    assert clean.parse_number(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1", "1호선"),
        ("1호선", "1호선"),
        ("1,2", "1,2호선"),
        ("1, 2", "1,2호선"),
        ("1,2호선", "1,2호선"),
        ("", None),
        # 가장자리: 0 은 호선 번호가 아니다(고치지 않고 그대로 둔다). 자리표시는 없는 값이다.
        ("0", "0"),
        ("10", "10호선"),
        ("-", None),
        ("경의중앙선", "경의중앙선"),
    ],
)
def test_normalize_line(raw: str, expected: str | None) -> None:
    assert clean.normalize_line(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("서울역(1)", "서울역"),
        ("종로3가(1)", "종로3가역"),
        ("강남", "강남역"),
        ("홍대입구역", "홍대입구역"),
        (" ", None),
        # 가장자리: 자리표시는 역이 아니다. 호선이 둘 적힌 괄호도 뗀다. 역 이름인지는 판단하지 않는다(알려진 한계).
        ("-", None),
        ("시청역(1,2)", "시청역"),
        ("시청(1, 2)", "시청역"),
        ("본사", "본사역"),
    ],
)
def test_normalize_station(raw: str, expected: str | None) -> None:
    assert clean.normalize_station(raw) == expected


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("대구광역시 북구 침산로 138 7층", "대구광역시 북구"),
        ("경기도 수원시 팔달구 인계동 1009-2", "경기도 수원시 팔달구"),
        ("전북특별자치도 무주군 부남면 대소길 3", "전북특별자치도 무주군"),
        ("노송광장로 10", None),
        (None, None),
        # 줄여 적은 광역시 이름도 같은 규칙으로 읽는다. 줄인 이름만 있으면 지역으로 읽지 않는다.
        ("대구 북구 침산로", "대구 북구"),
        ("서울 강남구 가상로 1", "서울 강남구"),
        ("서울", None),
        ("-", None),
    ],
)
def test_region_of_address(address: str | None, expected: str | None) -> None:
    assert clean.region_of_address(address) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4", (4, None)),
        ("0", (0, "quantity_zero")),
        ("15.5", (None, "quantity_not_integer")),
        ("많음", (None, "quantity_unreadable")),
        ("-1", (None, "quantity_unreadable")),
        ("", (None, None)),
    ],
)
def test_read_quantity(raw: str, expected: tuple[int | None, str | None]) -> None:
    assert clean.read_quantity(raw) == expected


@pytest.mark.parametrize(
    ("lat", "lng", "expected"),
    [
        ("35.5", "127.5", (35.5, 127.5, None)),
        ("35.97356000 ", "127.55906800 ", (35.97356, 127.559068, None)),
        ("생략", "생략", (None, None, "coord_not_number")),
        ("0", "0", (None, None, "coord_zero")),
        # 한쪽만 0 이어도, 한쪽만 견본 값이어도 좌표 전체를 믿지 않는다
        ("0", "127.5", (None, None, "coord_zero")),
        ("35.5", "0", (None, None, "coord_zero")),
        ("35.123456", "127.123456", (None, None, "coord_sample")),
        ("35.123456", "127.5", (None, None, "coord_sample")),
        ("35.5", "127.123456", (None, None, "coord_sample")),
        ("35.5", "", (None, None, "coord_not_number")),
        ("35.5", "126.666152", (None, None, "coord_out_of_area")),
        ("35.5", "", (None, None, "coord_not_number")),
        ("", "", (None, None, None)),
    ],
)
def test_read_coords(lat: str, lng: str, expected: tuple[float | None, float | None, str | None]) -> None:
    assert clean.read_coords(lat, lng, BOX) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9999-12-31", "end_date_open"),
        ("2026-01-05", "end_date_passed"),
        ("2026-10-12", None),
        ("2029-02-24", None),
        ("2026-02-30", "end_date_unreadable"),
        ("미정", "end_date_unreadable"),
        ("", None),
    ],
)
def test_read_end_date(raw: str, expected: str | None) -> None:
    assert clean.read_end_date(raw, TODAY) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("@가상카페", True), ("+", True), ("=1+1", True), ("+88 COFFEE", True), ("+3", False), ("가+나", False), ("", False)],
)
def test_looks_like_formula(raw: str, expected: bool) -> None:
    assert clean.looks_like_formula(raw) is expected


def test_clip_text_cuts_at_200_and_says_so() -> None:
    assert clean.clip_text("가" * 200) == ("가" * 200, False)
    assert clean.clip_text("가" * 201) == ("가" * 200, True)
