"""규격 읽기. 실제 자료에 나온 꼴을 그대로 넣는다."""

import pytest

from collector.size import Size, parse_size, size_from_columns


@pytest.mark.parametrize(
    ("text", "unit", "stated", "expected"),
    [
        # 단위가 값에 붙어 있다 → 단위를 짐작한 것이 아니다
        ("4206mm*1262mm", "mm", False, Size(4.206, 1.262)),
        # 칸 이름이 cm 라고 말한다
        ("540x100", "cm", True, Size(5.4, 1.0)),
        ("384X64", "cm", True, Size(3.84, 0.64)),
        ("8X0.9", "m", True, Size(8.0, 0.9)),
        ("2.6 x 0.38", "m", True, Size(2.6, 0.38)),
        # 단위가 어디에도 없다 → m 로 보고 표시한다
        ("6*0.9", "m", False, Size(6.0, 0.9, unit_assumed=True)),
        ("9.*3.4", "m", False, Size(9.0, 3.4, unit_assumed=True)),
        ("3.5*.2", "m", False, Size(3.5, 0.2, unit_assumed=True)),
        ("3.2* 2.4", "m", False, Size(3.2, 2.4, unit_assumed=True)),
        # 단위가 한쪽 수에만 붙어 있으면 그 단위를 두 수에 함께 쓴다(기본 단위가 mm 인 출처의 "3*4m" 를 0.003 × 4 로 읽지 않는다)
        ("3*4m", "mm", False, Size(3.0, 4.0)),
        ("5m*300", "m", False, Size(5.0, 300.0)),
        ("540cm x 100", "mm", False, Size(5.4, 1.0)),
        ("4206*1262mm", "m", False, Size(4.206, 1.262)),
        # 기본 단위가 mm 인 출처에서 단위 없는 값은 mm 로 읽고 표시한다(m 로 보는 것이 아니다)
        ("4206*1262", "mm", False, Size(4.206, 1.262, unit_assumed=True)),
        # 셋째 수(높이)와 끝의 "높이:N" 은 가로·세로가 아니다
        ("0.8*3.5*7.5", "m", False, Size(0.8, 3.5, unit_assumed=True)),
        ("1.5*2    높이:6", "m", False, Size(1.5, 2.0, unit_assumed=True)),
        ("0.8*1.5,  높이:8", "m", False, Size(0.8, 1.5, unit_assumed=True)),
    ],
)
def test_one_face(text: str, unit: str, stated: bool, expected: Size) -> None:
    assert parse_size(text, unit, stated) == expected


@pytest.mark.parametrize(
    "text",
    ["0.6*3.6   0.6*3.6", "0.8*2.0    0.8*2    높이:10", "0.8*0.9 , 0.8*0.9", "2.2*2.25, 2.2*2.25,  높이:9.75"],
)
def test_same_faces_use_that_size_and_mark(text: str) -> None:
    size = parse_size(text, "m", False)
    assert size.width_m is not None and size.height_m is not None
    assert size.marks == ("size_faces_same",)


@pytest.mark.parametrize(
    "text",
    ["16.5*9    16.5*9    13.5*9    13.5*9", "11.2*1    16.8*1.2", "8.4*0.8, 9.35*0.8", "20*9    19.1*9    19.1*9    높이:15"],
)
def test_different_faces_are_not_chosen(text: str) -> None:
    assert parse_size(text, "m", False) == Size(marks=("size_faces_differ",))


@pytest.mark.parametrize("text", ["6,5*1", "0.4*2,5", "가로 3미터", "3", "3*4*5*6", "12ft*3ft", "3m*400cm", "3mm*4m", "3*4m*5cm"])
def test_unreadable_is_marked_not_guessed(text: str) -> None:
    assert parse_size(text, "m", False) == Size(marks=("size_unreadable",))


def test_blank_has_no_size_and_no_mark() -> None:
    assert parse_size("", "m", False) == Size()
    assert parse_size(None, "m", False) == Size()


def test_zero_is_marked() -> None:
    assert parse_size("0*3", "m", False) == Size(marks=("size_zero",))


def test_two_columns() -> None:
    assert size_from_columns("12.8", "7.68", "m", True) == Size(12.8, 7.68)
    assert size_from_columns("0.8", "3.5", "m", False) == Size(0.8, 3.5, unit_assumed=True)
    assert size_from_columns("0", "0", "m", False) == Size(marks=("size_zero",))
    assert size_from_columns("넓음", "3", "m", False) == Size(marks=("size_unreadable",))
    assert size_from_columns("", "", "m", False) == Size()


def test_comma_followed_by_space_splits_faces_but_a_bare_comma_does_not() -> None:
    # "3*2, 3*2" 는 면 둘이다. "6,5*1" 의 쉼표는 소수점인지 알 수 없어 읽지 않는다.
    assert parse_size("3*2, 3*2", "m", True) == Size(3.0, 2.0, marks=("size_faces_same",))
    assert parse_size("3*2 ,3*2", "m", True) == Size(3.0, 2.0, marks=("size_faces_same",))
    assert parse_size("3*2,3*2", "m", True) == Size(marks=("size_unreadable",))


def test_unit_on_every_face_is_needed_to_call_it_stated() -> None:
    # 면 하나에만 단위가 있으면 나머지 면은 기본 단위로 본 것이다.
    assert parse_size("3m*2m   3*2", "m", False) == Size(3.0, 2.0, unit_assumed=True, marks=("size_faces_same",))
    assert parse_size("3m*2m   3m*2m", "m", False) == Size(3.0, 2.0, marks=("size_faces_same",))


def test_two_columns_zero_on_one_side_is_zero() -> None:
    assert size_from_columns("0", "3", "m", True) == Size(marks=("size_zero",))
    assert size_from_columns("3", "0", "m", True) == Size(marks=("size_zero",))
    assert size_from_columns("3", "", "m", True) == Size(marks=("size_unreadable",))
