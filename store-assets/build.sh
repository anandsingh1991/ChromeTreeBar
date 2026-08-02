#!/bin/bash
# Builds Chrome Web Store + GitHub images from the raw panel captures in raw/.
# Requires ImageMagick 7 (`magick`). Run from store-assets/: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

FONT="/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_R="/System/Library/Fonts/Supplemental/Arial.ttf"
OUT=out
mkdir -p "$OUT"

# Store screenshot: 1280x800, panel inset on a gradient with a headline + subhead.
# Bound BOTH axes: crops differ in aspect, and scaling by height alone made short
# crops wide enough to run under the text column.
shot() {
  local src=$1 title=$2 sub=$3 out=$4 grad=$5
  # Light gradients need dark type; pass the pair explicitly rather than guessing.
  local tfill=${6:-#ffffff} sfill=${7:-#dbe4ff}

  magick -size 1280x800 "gradient:${grad}" \
    -alpha off "$OUT/_bg.png"

  # Rounded corners + drop shadow on the panel so it lifts off the background.
  magick "$src" -resize 560x680\> \
    \( +clone -alpha extract \
       -draw 'fill black polygon 0,0 0,14 14,0 fill white circle 14,14 14,0' \
       \( +clone -flip \) -compose Multiply -composite \
       \( +clone -flop \) -compose Multiply -composite \
    \) -alpha off -compose CopyOpacity -composite "$OUT/_panel.png"

  magick "$OUT/_panel.png" \( +clone -background black -shadow 55x18+0+8 \) \
    +swap -background none -layers merge +repage "$OUT/_panel_sh.png"

  magick "$OUT/_bg.png" "$OUT/_panel_sh.png" -gravity east -geometry +90+0 -composite \
    -font "$FONT"   -pointsize 46 -fill "$tfill" \
      -gravity northwest -annotate +80+250 "$title" \
    -font "$FONT_R" -pointsize 25 -fill "$sfill" \
      -gravity northwest -annotate +80+336 "$sub" \
    "$OUT/$out"
  printf '  %-34s' "$out"; magick identify -format '%wx%h\n' "$OUT/$out"
}

echo "Store screenshots (1280x800):"
shot raw/trim-hero.png \
  "Every tab in a tree" \
  "Nest tabs under tabs. Native groups\nand pinned tabs, all in one panel." \
  screenshot-1-tree.png "#1f2c4d-#0d1424"

shot raw/trim-search.png \
  "Find any tab fast" \
  "Search filters open tabs, bookmarks\nand pinned tabs as you type." \
  screenshot-2-search.png "#123d3a-#08201f"

shot raw/trim-groups.png \
  "Never lose a group" \
  "Closed groups are saved with their\ntabs and nesting. Restore in a click." \
  screenshot-3-groups.png "#3d1f4d-#1a0d24"

shot raw/trim-menu.png \
  "Powerful right-click" \
  "Pin, duplicate, group, or close a tab\nwith its children - or all the others." \
  screenshot-4-menu.png "#4d2f14-#241408"

shot raw/trim-light.png \
  "Light or dark" \
  "Pick a theme, or let the panel\nfollow your system automatically." \
  screenshot-5-theme.png "#e8ecf5-#c2ccdf" "#16203a" "#41506f"

# Promo tiles: icon + wordmark, no screenshot (they render small).
echo "Promo tiles:"
magick -size 440x280 'gradient:#1f2c4d-#0d1424' -alpha off \
  \( ../icons/icon128.png -resize 96x96 \) -gravity northwest -geometry +40+62 -composite \
  -font "$FONT"   -pointsize 34 -fill white   -gravity northwest -annotate +156+78 'ChromeTreeBar' \
  -font "$FONT_R" -pointsize 19 -fill '#a9b8dd' -gravity northwest -annotate +158+124 'Tabs in a tree' \
  -font "$FONT_R" -pointsize 17 -fill '#8fa0c8' -gravity northwest -annotate +40+196 'Nest - Group - Pin - Search' \
  "$OUT/promo-small-440x280.png"
printf '  %-34s' promo-small-440x280.png; magick identify -format '%wx%h\n' "$OUT/promo-small-440x280.png"

# Staged, not one nested pipeline: inlining the rounded-corner clone into a composite
# silently dropped the gradient and the panel, yielding a near-blank tile.
round() {  # round <src> <resize-geom> <radius> <dst>
  magick "$1" -resize "$2" \
    \( +clone -alpha extract \
       -draw "fill black polygon 0,0 0,$3 $3,0 fill white circle $3,$3 $3,0" \
       \( +clone -flip \) -compose Multiply -composite \
       \( +clone -flop \) -compose Multiply -composite \
    \) -alpha off -compose CopyOpacity -composite "$4"
}

round raw/trim-hero.png x470 12 "$OUT/_m_panel.png"
magick -size 1400x560 'gradient:#1f2c4d-#0d1424' -alpha off "$OUT/_m_bg.png"
magick ../icons/icon128.png -resize 76x76 "$OUT/_m_icon.png"
magick "$OUT/_m_bg.png" "$OUT/_m_panel.png" -gravity east -geometry +110+0 -composite \
  "$OUT/_m_icon.png" -gravity northwest -geometry +90+150 -composite \
  "$OUT/_m_flat.png"
magick "$OUT/_m_flat.png" \
  -font "$FONT"   -pointsize 46 -fill white     -gravity northwest -annotate +182+158 'ChromeTreeBar' \
  -font "$FONT_R" -pointsize 25 -fill '#b9c6e6' -gravity northwest -annotate +92+268 'Manage every tab in a drag-and-drop tree.' \
  -font "$FONT_R" -pointsize 25 -fill '#b9c6e6' -gravity northwest -annotate +92+306 'Groups, pinned tabs, and instant search.' \
  "$OUT/promo-marquee-1400x560.png"
printf '  %-34s' promo-marquee-1400x560.png; magick identify -format '%wx%h\n' "$OUT/promo-marquee-1400x560.png"

# GitHub README hero: 2x for retina, panel beside feature bullets.
echo "GitHub:"
round raw/trim-hero.png x760 16 "$OUT/_g_panel.png"
magick "$OUT/_g_panel.png" \( +clone -background black -shadow 60x24+0+10 \) \
  +swap -background none -layers merge +repage "$OUT/_g_panel_sh.png"
magick -size 1600x900 'gradient:#161b26-#0b0e14' -alpha off "$OUT/_g_bg.png"
magick "$OUT/_g_bg.png" "$OUT/_g_panel_sh.png" -gravity east -geometry +80+0 -composite \
  -font "$FONT"   -pointsize 58 -fill white     -gravity northwest -annotate +80+150 'ChromeTreeBar' \
  -font "$FONT_R" -pointsize 28 -fill '#9aa7bd' -gravity northwest -annotate +82+232 'Tree-style tab management for Chrome' \
  -font "$FONT_R" -pointsize 24 -fill '#cfd8e6' -gravity northwest \
    -annotate +84+330 'Nest tabs by drag and drop' \
    -annotate +84+382 'Native tab groups, color-coded' \
    -annotate +84+434 'Pinned tabs in a compact strip' \
    -annotate +84+486 'Saved groups, restored with nesting' \
    -annotate +84+538 'Search tabs and bookmarks at once' \
  "$OUT/github-hero.png"
printf '  %-34s' github-hero.png; magick identify -format '%wx%h\n' "$OUT/github-hero.png"

rm -f "$OUT"/_*.png
echo "Done -> $OUT/"
