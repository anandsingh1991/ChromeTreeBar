# Store listing artwork

`build.sh` composites the Chrome Web Store screenshots, promo tiles, and the GitHub hero from raw side-panel captures. Only the script is tracked — `raw/` and `out/` are gitignored, since the captures are re-shootable and the renders only ever go to the dashboard.

## Rebuilding

Needs ImageMagick 7 (`brew install imagemagick`).

```bash
cd store-assets && ./build.sh   # reads raw/trim-*.png, writes out/
```

## Recapturing the panel

`raw/trim-*.png` are cropped from full-panel screenshots taken at 420x800 with a 2x device pixel ratio (so 1212x1600). To reshoot: load the extension unpacked, open the side panel with a representative set of tabs — a couple of colored groups, two or three levels of nesting, and 5-6 pinned tabs so the pills visibly shrink — then crop out the empty band between the last row and the action bar.

The crops are framed per shot, not uniformly: `trim-groups` and `trim-menu` are tight around the dialog and context menu so those stay legible once scaled into the 1280x800 frame. `build.sh` bounds the panel on both axes (`560x680>`) — scaling by height alone made the shorter crops wide enough to run under the caption text.

## Output

| File | Size | Where it goes |
|---|---|---|
| `screenshot-1-tree.png` … `-5-theme.png` | 1280x800 | Store listing screenshots (max 5) |
| `promo-small-440x280.png` | 440x280 | Store small promo tile |
| `promo-marquee-1400x560.png` | 1400x560 | Store marquee promo tile |
| `github-hero.png` | 1600x900 | Copied to `docs/images/hero.png` for the README |

Captions live in the `shot` calls in `build.sh`. Keep headlines under ~470px at 46pt Arial Bold and subhead lines under ~470px at 25pt regular, or they collide with the panel — the script does not wrap or check.
