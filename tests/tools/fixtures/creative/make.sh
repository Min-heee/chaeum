#!/bin/bash
# 시안 검사 시험 재료를 다시 만드는 스크립트. 저장소 맨 위에서 돌린다:
#   bash tests/tools/fixtures/creative/make.sh
# 필요한 도구: ffmpeg, cwebp·img2webp(libwebp), jpegtran. 시험을 돌리는 데는 필요 없다(만든 파일이 저장소에 들어 있다).
# 모두 단색 그림·영상이다. 사람도 글자도 없다. 합쳐 200KB 를 넘기지 않는다.
# 도구 판이 바뀌면 바이트가 달라질 수 있다. 시험은 바이트가 아니라 읽은 값(형식·가로·세로·길이)을 본다.
set -euo pipefail

OUT="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
COLOR=0x1f5fd1

ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
# 만든 날짜와 도구 판 글자를 파일에 남기지 않는다. 코덱 이름("Lavc libx264" 같은 것)은 영상 항목에 남는다.
PLAIN=(-fflags +bitexact -flags:v +bitexact -map_metadata -1)

still() { # still 가로x세로 파일
  ff -f lavfi -i "color=c=$COLOR:s=$1" -frames:v 1 "${PLAIN[@]}" "$2"
}
jpg() { # jpg 가로x세로 파일
  ff -f lavfi -i "color=c=$COLOR:s=$1" -frames:v 1 -q:v 31 -huffman optimal "${PLAIN[@]}" "$2"
}
# h264 영상. 1초에 FPS 장, 소리 없음. 부가 정보 조각(SEI)은 뗀다.
clip() { # clip 가로x세로 초 FPS 파일 [덧붙일 옵션…]
  local size="$1" seconds="$2" fps="$3" out="$4"
  shift 4
  ff -f lavfi -i "color=c=$COLOR:s=$size:r=$fps" -t "$seconds" -c:v libx264 -preset veryslow -crf 51 -g 600 -pix_fmt yuv420p \
    -bsf:v filter_units=remove_types=6 -an "${PLAIN[@]}" "$@" "$out"
}

# ── 규격에 맞는 파일 ──────────────────────────────────────
# 가로 전광판(1920x1080, jpg·mp4, 한 번 15초)
jpg 1920x1080 "$OUT/board-1920x1080.jpg"
clip 1920x1080 15 1 "$OUT/board-1920x1080-15s.mp4"
clip 1920x1080 15 1 "$OUT/board-1920x1080-15s-faststart.mp4" -movflags +faststart
# 세로 조명 광고(1080x1920, jpg·png)
still 1080x1920 "$OUT/pillar-1080x1920.png"
jpg 1080x1920 "$TMP/pillar.jpg"
jpegtran -progressive -outfile "$OUT/pillar-1080x1920-progressive.jpg" "$TMP/pillar.jpg"
# 쉘터 화면(1280x720, png·webp·mp4, 한 번 10초)
still 1280x720 "$OUT/shelter-1280x720.png"
cwebp -quiet -q 10 "$OUT/shelter-1280x720.png" -o "$OUT/shelter-1280x720-lossy.webp"
cwebp -quiet -lossless "$OUT/shelter-1280x720.png" -o "$OUT/shelter-1280x720-lossless.webp"
ff -f lavfi -i "color=c=$COLOR@0.5:s=1280x720,format=rgba" -frames:v 1 "${PLAIN[@]}" "$TMP/alpha.png"
cwebp -quiet -q 10 "$TMP/alpha.png" -o "$OUT/shelter-1280x720-alpha.webp"
ff -f lavfi -i "color=c=$COLOR:s=1280x720:r=1" -t 10 -c:v libx265 -x265-params log-level=error:info=0 -crf 51 -pix_fmt yuv420p -tag:v hvc1 \
  -bsf:v filter_units=remove_types=39 -an "${PLAIN[@]}" "$OUT/shelter-1280x720-10s-hevc.mp4"

# ── 일부러 틀리게 만든 파일 ────────────────────────────────
# 해상도 다름(비율은 같음)
jpg 960x540 "$OUT/small-960x540.jpg"
clip 1280x720 15 1 "$OUT/small-1280x720-15s.mp4"
# 비율이 반올림만큼만 다름(16:9 를 480줄로 줄인 크기)
still 853x480 "$OUT/rounded-853x480.png"
# 비율 다름
jpg 1080x1080 "$OUT/square-1080x1080.jpg"
# 길이 다름: 10초(짧음), 15.4초(봐주는 폭 안), 15.6초(폭 밖)
clip 1920x1080 10 1 "$OUT/board-1920x1080-10s.mp4"
clip 1920x1080 15.4 5 "$OUT/board-1920x1080-15.4s.mp4"
clip 1920x1080 15.6 5 "$OUT/board-1920x1080-15.6s.mp4"
# 회전 표식: 저장된 크기는 1920x1080 이고 "시계 방향으로 90도 돌려서 보여 주라"는 표식이 붙었다(휴대전화로 세워 찍은 영상의 꼴).
# ffmpeg 의 -display_rotation 은 시계 반대 방향으로 센다. 그래서 시계 방향 90도는 -90 이다.
ff -display_rotation -90 -i "$OUT/board-1920x1080-15s.mp4" -c copy "${PLAIN[@]}" "$OUT/phone-1920x1080-turn90.mp4"
# 180도(가로·세로는 그대로), 시계 방향 270도
clip 320x180 1 1 "$TMP/tiny.mp4"
ff -display_rotation 180 -i "$TMP/tiny.mp4" -c copy "${PLAIN[@]}" "$OUT/tiny-320x180-turn180.mp4"
ff -display_rotation 90 -i "$TMP/tiny.mp4" -c copy "${PLAIN[@]}" "$OUT/tiny-320x180-turn270.mp4"
# 조각으로 나뉜 MP4: 머리에 전체 길이가 없다
clip 1280x720 10 1 "$OUT/fragmented-1280x720.mp4" -movflags +frag_keyframe+empty_moov+default_base_moof
# 옛 코덱(영상 항목의 이름이 다르다). 크기는 같은 자리에 있다
ff -f lavfi -i "color=c=$COLOR:s=320x180:r=1" -t 2 -c:v mpeg4 -q:v 31 -an "${PLAIN[@]}" "$OUT/oldcodec-320x180.mp4"
# 움직이는 WEBP: 그림으로 읽는다(길이는 읽지 않는다)
still 320x180 "$TMP/f1.png"
ff -f lavfi -i "color=c=0xd11f5f:s=320x180" -frames:v 1 "${PLAIN[@]}" "$TMP/f2.png"
img2webp -lossy -q 10 -d 500 "$TMP/f1.png" "$TMP/f2.png" -o "$OUT/moving-320x180.webp" >/dev/null 2>&1

# 형식 다름·확장자 속임(내용이 기준이다)
# 이름은 jpg, 내용은 PNG. ffmpeg 는 이름의 확장자로 형식을 고르므로 png 로 만든 뒤 이름만 바꾼다.
still 1920x1080 "$TMP/board.png"
cp "$TMP/board.png" "$OUT/png-inside.jpg"
ff -f lavfi -i "color=c=$COLOR:s=320x180:r=1" -t 1 -c:v libx264 -preset veryslow -crf 51 -pix_fmt yuv420p \
  -bsf:v filter_units=remove_types=6 -an "${PLAIN[@]}" -f mov "$OUT/quicktime-inside.mp4"   # 이름은 mp4, 내용은 QuickTime
ff -f lavfi -i "color=c=$COLOR:s=16x16" -frames:v 1 "${PLAIN[@]}" -f gif "$OUT/gif-inside.png"   # 이름은 png, 내용은 GIF
printf '시안 파일이 아니라 글자입니다.\n' >"$OUT/text-inside.png"       # 이름은 png, 내용은 글
ff -f lavfi -i "anullsrc=r=8000:cl=mono" -t 1 -c:a aac -b:a 8k -flags:a +bitexact "${PLAIN[@]}" "$OUT/sound-only.mp4"   # 영상 트랙이 없는 MP4
# 영상 15초 + 소리 17초. 파일 전체의 길이(17초)가 아니라 영상 트랙의 길이(15초)로 견주는지 본다.
ff -f lavfi -i "anullsrc=r=8000:cl=mono" -t 17 -c:a aac -b:a 8k -flags:a +bitexact "${PLAIN[@]}" "$TMP/a17.mp4"
ff -i "$OUT/board-1920x1080-15s.mp4" -i "$TMP/a17.mp4" -map 0:v -map 1:a -c copy "${PLAIN[@]}" "$OUT/board-1920x1080-15s-sound17s.mp4"

# 잘린 파일
head -c 20 "$OUT/pillar-1080x1920.png" >"$OUT/cut-head.png"             # 머리(IHDR)가 다 들어오기 전에 끊김
head -c 2000 "$OUT/pillar-1080x1920.png" >"$OUT/cut-tail.png"           # 머리는 멀쩡하고 뒤가 없음
head -c 100 "$OUT/board-1920x1080.jpg" >"$OUT/cut-head.jpg"             # 크기 표식(SOF)이 나오기 전에 끊김
head -c 3000 "$OUT/board-1920x1080.jpg" >"$OUT/cut-tail.jpg"            # 크기는 읽히지만 끝 표식이 없음
head -c 1000 "$OUT/shelter-1280x720-lossy.webp" >"$OUT/cut-tail.webp"   # 그릇에 적힌 길이보다 짧음
head -c 1500 "$OUT/board-1920x1080-15s.mp4" >"$OUT/cut-tail.mp4"        # 머리 상자(moov)가 파일 끝에 있어 통째로 사라짐
size=$(wc -c <"$OUT/board-1920x1080-15s-faststart.mp4")
head -c $((size - 500)) "$OUT/board-1920x1080-15s-faststart.mp4" >"$OUT/cut-tail-faststart.mp4"   # 머리 상자는 멀쩡하고 영상 자료가 끊김

rm -rf "$TMP"
echo "만든 파일: $(find "$OUT" -type f ! -name make.sh | wc -l | tr -d ' ')개, 합쳐 $(find "$OUT" -type f ! -name make.sh -exec cat {} + | wc -c | tr -d ' ')바이트"
