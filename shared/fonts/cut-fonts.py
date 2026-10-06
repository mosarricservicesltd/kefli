"""Cut the app's static fonts from the variable sources (mobile spec 6.3).

    python3 shared/fonts/cut-fonts.py           write shared/fonts/out/<family>.ttf
    python3 shared/fonts/cut-fonts.py --check   exit 1 if out/ doesn't match a fresh cut

The cuts come from shared/fonts/cuts.json, which shared/tokens/build-ts.mjs writes from tokens.json.
Each axis a cut names is pinned to that value; any other axis stays at the font's default. Every cut
is renamed to its family (Archivo-650 and so on), so expo-font registers one family per weight and
Android never synthesises a weight. None of the three OFL licences reserves a font name. Needs
fontTools 4.60 (pip install --user fonttools==4.60.*).
"""

import io
import json
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = Path(__file__).resolve().parent
SOURCES = {
    'Archivo': 'Archivo[wdth,wght].ttf',
    'Literata': 'Literata[opsz,wght].ttf',
    'Literata Italic': 'Literata-Italic[opsz,wght].ttf',
    'Martian Mono': 'MartianMono[wdth,wght].ttf',
}


RENAMED_IDS = {1, 2, 3, 4, 6, 16, 17, 21, 22, 25}


def drop_names(font: TTFont) -> None:
    """Remove the family, style and variation names the cut replaces."""
    names = font['name']
    for rec in list(names.names):
        if rec.nameID in RENAMED_IDS or rec.nameID >= 256:
            names.removeNames(nameID=rec.nameID)


def rename(font: TTFont, family: str) -> None:
    """One family per cut, style Regular (or Italic), with no typographic family left to regroup them."""
    italic = family.endswith('-Italic')
    style = 'Italic' if italic else 'Regular'
    drop_names(font)
    full = f'{family} {style}' if italic else family
    for name_id, value in ((1, family), (2, style), (3, f'{family};shelf-cut'), (4, full), (6, family)):
        font['name'].setName(value, name_id, 3, 1, 0x409)
    font['OS/2'].usWeightClass = 400
    # fsSelection: ITALIC (bit 0) or REGULAR (bit 6), with BOLD (bit 5) cleared; macStyle bit 1 is italic.
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~0b1100001) | (0b1 if italic else 0b1000000)
    font['head'].macStyle = 0b10 if italic else 0
    if 'STAT' in font:
        del font['STAT']


def cut(family: str, spec: dict) -> bytes:
    font = TTFont(HERE / 'src' / SOURCES[spec['source']], recalcTimestamp=False)
    axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes}
    for tag in axes:
        if tag in spec:
            axes[tag] = float(spec[tag])
    static = instantiateVariableFont(font, axes, updateFontNames=False)
    rename(static, family)
    # Fixed timestamps, so a cut is byte-identical on every run.
    static.recalcTimestamp = False
    static['head'].created = static['head'].modified = 0
    buf = io.BytesIO()
    static.save(buf, reorderTables=True)
    return buf.getvalue()


def write(out: Path, cuts: dict) -> None:
    for family, spec in cuts.items():
        data = cut(family, spec)
        path = out / f'{family}.ttf'
        path.write_bytes(data)
        print(f'wrote {path.relative_to(HERE.parent.parent)} ({len(data) // 1024} KB)')


def stale(out: Path, cuts: dict) -> list[str]:
    """Cuts whose file is missing or differs from a fresh cut."""
    return [f for f, spec in cuts.items() if not (out / f'{f}.ttf').exists() or (out / f'{f}.ttf').read_bytes() != cut(f, spec)]


def main() -> int:
    cuts = json.loads((HERE / 'cuts.json').read_text())['cuts']
    out = HERE / 'out'
    out.mkdir(exist_ok=True)
    extra = sorted(p.name for p in out.glob('*.ttf') if p.stem not in cuts)
    for name in extra:
        print(f'not in cuts.json: shared/fonts/out/{name}')
    if '--check' not in sys.argv:
        write(out, cuts)
        return 0
    bad = stale(out, cuts)
    for f in bad:
        print(f'stale: shared/fonts/out/{f}.ttf')
    if bad or extra:
        print('run: python3 shared/fonts/cut-fonts.py')
        return 1
    print(f'shared/fonts/out matches {len(cuts)} cuts')
    return 0


if __name__ == '__main__':
    sys.exit(main())
