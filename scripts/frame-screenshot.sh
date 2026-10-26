#!/bin/bash
# Wraps a raw screenshot in a browser-window frame (title bar, rounded corners, drop shadow)
# on a transparent background, for the README. Needs ImageMagick 7.
#   scripts/frame-screenshot.sh docs/assets/focus-dark.png docs/assets/framed-dark.png "#161B22" "#0D1117" "#8B96A8" "#30363D" "#2F6FEB" "38x34+0+18"
#   scripts/frame-screenshot.sh docs/assets/focus-light.png docs/assets/framed-light.png "#EAEEF2" "#FFFFFF" "#59636E" "#D0D7DE"
# Args: <in.png> <out.png> <bar-bg> <url-pill-bg> <url-fg> <border> [shadow-colour] [shadow-geometry]
set -e
IN=$1; OUT=$2; BAR=$3; PILL=$4; FG=$5; BORDER=$6
W=$(magick identify -format %w "$IN"); H=$(magick identify -format %h "$IN")
FONT=/System/Library/Fonts/Menlo.ttc
T=$(mktemp -d)
# title bar with traffic lights and a URL pill
magick -size ${W}x44 xc:"$BAR" \
  -fill "#FF5F57" -draw "circle 22,22 28,22" \
  -fill "#FEBC2E" -draw "circle 42,22 48,22" \
  -fill "#28C840" -draw "circle 62,22 68,22" \
  -fill "$PILL" -draw "roundrectangle $((W/2-230)),9 $((W/2+230)),35 8,8" \
  -font "$FONT" -pointsize 13 -fill "$FG" -gravity center -annotate +0+0 "127.0.0.1:7317/b/rate-limits" \
  "$T/bar.png"
magick "$T/bar.png" "$IN" -append "$T/win.png"
WH=$((H+44))
# rounded corners + hairline border
magick -size ${W}x${WH} xc:none -fill white -draw "roundrectangle 0,0 $((W-1)),$((WH-1)) 14,14" "$T/mask.png"
magick "$T/win.png" "$T/mask.png" -alpha off -compose CopyOpacity -composite \
  -fill none -stroke "$BORDER" -strokewidth 1 -draw "roundrectangle 0,0 $((W-1)),$((WH-1)) 14,14" "$T/round.png"
# soft drop shadow on a transparent canvas
magick "$T/round.png" \( +clone -background "${7:-#0B1020}" -shadow ${8:-42x30+0+26} \) +swap \
  -background none -layers merge +repage -bordercolor none -border 24 "$OUT"
rm -rf "$T"
