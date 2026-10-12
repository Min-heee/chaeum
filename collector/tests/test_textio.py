"""인코딩 판별과 CSV 읽기."""

from pathlib import Path

import pytest

import csv

from collector.textio import UnreadableFile, count_lines, detect_encoding, read_records

from .conftest import FIXTURES

TEXT = "이름,값\r\n가나다,1\r\n"


def write(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / "file.csv"
    path.write_bytes(data)
    return path


def test_bom_means_utf8_sig(tmp_path: Path) -> None:
    path = write(tmp_path, b"\xef\xbb\xbf" + TEXT.encode("utf-8"))
    assert detect_encoding(path, None) == ("utf-8-sig", False)
    assert next(read_records(path, "utf-8-sig")) == ["이름", "값"]  # 첫 칸 이름에 BOM 이 붙지 않는다


def test_utf8_without_bom_is_not_a_guess(tmp_path: Path) -> None:
    assert detect_encoding(write(tmp_path, TEXT.encode("utf-8")), None) == ("utf-8", False)


def test_cp949_with_matching_hint_is_not_a_guess(tmp_path: Path) -> None:
    assert detect_encoding(write(tmp_path, TEXT.encode("cp949")), "cp949") == ("cp949", False)


def test_cp949_without_hint_is_a_guess(tmp_path: Path) -> None:
    assert detect_encoding(write(tmp_path, TEXT.encode("cp949")), None) == ("cp949", True)


def test_hint_that_turned_out_wrong_is_a_guess(tmp_path: Path) -> None:
    assert detect_encoding(write(tmp_path, TEXT.encode("cp949")), "utf-8-sig") == ("cp949", True)


def test_utf8_that_decodes_to_the_end_is_never_a_guess(tmp_path: Path) -> None:
    # 힌트가 cp949 여도 utf-8 로 끝까지 풀렸으면 짐작이 아니다(줄마다 "짐작" 표시가 붙지 않는다).
    assert detect_encoding(write(tmp_path, TEXT.encode("utf-8")), "cp949") == ("utf-8", False)


def test_utf8_is_tried_before_the_hint(tmp_path: Path) -> None:
    # utf-8 글은 cp949 로도 (깨진 글자로) 풀린다. 그래서 힌트보다 utf-8 을 먼저 본다.
    data = "name,value\r\ncafé,1\r\n".encode("utf-8")
    assert data.decode("cp949") != data.decode("utf-8")  # cp949 로도 풀리기는 하지만 다른 글자가 된다
    assert detect_encoding(write(tmp_path, data), "cp949")[0] == "utf-8"


def test_bom_followed_by_cp949_is_refused_not_misread(tmp_path: Path) -> None:
    # 앞머리(BOM)만 보고 utf-8 로 정하면 읽는 도중에 죽는다. 파일 전체를 풀어 본 뒤에 정한다.
    with pytest.raises(UnreadableFile, match="BOM"):
        detect_encoding(write(tmp_path, b"\xef\xbb\xbf" + TEXT.encode("cp949")), "cp949")


def test_a_character_cut_off_at_the_end_is_not_decodable(tmp_path: Path) -> None:
    # 끝 글자의 바이트가 모자란 파일. 마지막까지 풀어 봐야 알 수 있다.
    cut = "이름,값\r\n가".encode("utf-8")[:-1]
    with pytest.raises(UnreadableFile):
        detect_encoding(write(tmp_path, b"\xef\xbb\xbf" + cut), None)


def test_unclosed_quote_is_an_error_not_a_swallowed_file(tmp_path: Path) -> None:
    lines = ["이름,값", '가,"나', *(f"줄{n},{n}" for n in range(50))]
    path = write(tmp_path, ("\r\n".join(lines) + "\r\n").encode("utf-8"))
    with pytest.raises(csv.Error):
        list(read_records(path, "utf-8"))


def test_newline_inside_quotes_and_cr_only_lines_are_read(tmp_path: Path) -> None:
    path = write(tmp_path, '이름,값\r\n"가\r\n나",1\r\n다,2\r\n'.encode("utf-8"))
    assert list(read_records(path, "utf-8")) == [["이름", "값"], ["가\r\n나", "1"], ["다", "2"]]
    assert count_lines(path) == 4  # 줄바꿈은 넷, 읽은 줄은 셋(머리줄 포함)
    cr_only = write(tmp_path, "이름,값\r가,1\r나,2\r".encode("utf-8"))
    assert list(read_records(cr_only, "utf-8")) == [["이름", "값"], ["가", "1"], ["나", "2"]]


def test_count_lines_counts_a_last_line_without_newline(tmp_path: Path) -> None:
    assert count_lines(write(tmp_path, b"a\nb\n")) == 2
    assert count_lines(write(tmp_path, b"a\nb")) == 2
    assert count_lines(write(tmp_path, b"")) == 0


def test_bytes_that_fit_nothing_are_refused(tmp_path: Path) -> None:
    with pytest.raises(UnreadableFile):
        detect_encoding(write(tmp_path, b"a,b\r\n\xff\xff\xff\r\n"), None)


@pytest.mark.parametrize(
    ("name", "codec"),
    [("muju-led", "utf-8-sig"), ("iksan-led", "utf-8-sig"), ("imsil-led", "utf-8-sig"), ("jeonju-led", "cp949"), ("suwon-ooh-survey", "cp949")],
)
def test_fixture_encodings_are_mixed(name: str, codec: str) -> None:
    assert detect_encoding(FIXTURES / f"{name}.csv", codec) == (codec, False)


def test_comma_inside_quotes_stays_in_one_cell() -> None:
    records = list(read_records(FIXTURES / "busan-metro-ad-facilities.csv", "cp949"))
    assert records[0] == ["호선", "광고종류", "광고대행사", "상세위치"]
    assert records[2][3] == "대합실, 승강장"
    assert records[4][0] == "1,2호선"
    assert all(len(record) == 4 for record in records)


def test_last_line_without_newline_is_still_read() -> None:
    path = FIXTURES / "iksan-led.csv"
    assert not path.read_bytes().endswith(b"\n")
    assert len(list(read_records(path, "utf-8-sig"))) == 6
