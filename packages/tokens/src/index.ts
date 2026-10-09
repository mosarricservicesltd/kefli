// Generated from shared/tokens/tokens.json (v1.1.0, fingerprint) by shared/tokens/build-ts.mjs. Do not edit.

export const version = "1.1.0" as const;

/** Chrome colours per app theme, plus the scrim, the float shadow (a boxShadow string) and the cover greys. */
export const colors = {
  "light": {
    "background": "#F3F2EE",
    "surface": "#FFFFFF",
    "line": "#DEDCD5",
    "lineStrong": "#8C8A83",
    "text": "#17171A",
    "muted": "#5C5B56",
    "fill": "#17171A",
    "onFill": "#F3F2EE",
    "focus": "#17171A",
    "success": "#1E7A4A",
    "warning": "#8A4A00",
    "error": "#B42318",
    "scrim": "#17171A76",
    "shadowFloat": "0px 12px 28px -10px #17171A4D, 0px 0px 0px 1px #DEDCD5",
    "coverEdge": "#17171A17",
    "coverGrey": {
      "ground": "#E4E2DC",
      "soft": "#CFCCC4",
      "signal": "#A9A69F",
      "deep": "#8C8A83"
    }
  },
  "dark": {
    "background": "#111112",
    "surface": "#1A1A1C",
    "line": "#2E2E31",
    "lineStrong": "#7A7983",
    "text": "#EDECE8",
    "muted": "#A7A59F",
    "fill": "#EDECE8",
    "onFill": "#111112",
    "focus": "#EDECE8",
    "success": "#5DC68C",
    "warning": "#E9A65E",
    "error": "#FF8B7B",
    "scrim": "#00000099",
    "shadowFloat": "0px 0px 0px 1px #3A3A3E, 0px 12px 28px -10px #000000B3",
    "coverEdge": "#EDECE81A",
    "coverGrey": {
      "ground": "#29292D",
      "soft": "#3A3A3E",
      "signal": "#55545A",
      "deep": "#7A7983"
    }
  }
} as const;
export type ThemeName = keyof typeof colors;
export type ThemeColors = (typeof colors)[ThemeName];

/** Reading palettes for the Aa sheet. Night is tinted per article by ShelfCover.night(); these are its zero-chroma values. */
export const reader = {
  "themes": [
    "paper",
    "sepia",
    "night"
  ],
  "palette": {
    "paper": {
      "id": "light",
      "label": "Light",
      "bg": "#F7F6F2",
      "text": "#1C1C1F",
      "muted": "#5D5C57",
      "link": "#1C1C1F",
      "ink": "#1C1C1F",
      "highlight": "#C3C2BD",
      "fill": "#1C1C1F",
      "onFill": "#F7F6F2",
      "focus": "#1C1C1F"
    },
    "sepia": {
      "id": "sepia",
      "label": "Sepia",
      "bg": "#F2E9D8",
      "text": "#3B2F22",
      "muted": "#6A5B48",
      "link": "#3B2F22",
      "ink": "#3B2F22",
      "highlight": "#C9BEAD",
      "fill": "#3B2F22",
      "onFill": "#F2E9D8",
      "focus": "#3B2F22"
    },
    "night": {
      "id": "dark",
      "label": "Dark",
      "bg": "#191919",
      "text": "#DFDFDF",
      "muted": "#ACACAC",
      "link": "#DFDFDF",
      "ink": "#DFDFDF",
      "highlight": "#454545",
      "fill": "#DFDFDF",
      "onFill": "#191919",
      "focus": "#DFDFDF"
    }
  },
  "nightTint": {
    "bg": {
      "L": 0.215,
      "C": 0.022
    },
    "text": {
      "L": 0.905,
      "C": 0.012
    },
    "muted": {
      "L": 0.745,
      "C": 0.022
    }
  },
  "floatRingMix": 0.28,
  "floatShadow": "0px 12px 28px -10px #00000059",
  "size": 18,
  "sizeRange": [
    15,
    24
  ],
  "lineHeight": 1.6
} as const;

/** Article ink and spoken-word highlight rules, applied by ShelfCover.lineInk() and highlight(). */
export const article = {
  "ink": {
    "minContrast": 3,
    "fallback": "text",
    "use": "The one ink an article lends to lines and marks: its progress lines, link underlines, the toast countdown, Speed read's focus ticks, the word meter and the waiting dot (the focus letter itself sits on the highlight, flow decision 71). It is the first of its cover inks that clears 3:1 on the background under it, else its signal ink mixed towards the fallback in 10% steps, else the fallback (the text colour of that surface). Set per article by the cover module (lineInk), as --reader-ink in the Reader. 3:1 suits lines and large text only; small text stays the text colour."
  },
  "highlight": {
    "minTextContrast": 7,
    "wash": {
      "from": 0.34,
      "step": 0.02,
      "floor": 0.06
    },
    "use": "The spoken-word highlight, also the wash under Speed read's focus letter (flow decision 71): the article's signal ink washed into the page, starting at 34% and stepping down until the text on it keeps 7:1. Set per article by the cover module (highlight), as --reader-highlight. The static reader highlights below are the same rule with the muted colour as the wash, used only before an article's own value is applied."
  }
} as const;

/** One expo-font family per static cut. Use these with fontWeight left unset, so Android never synthesises a weight. */
export const fontFamily = {
  "ui": {
    "body": "Archivo-400",
    "meta": "Archivo-500",
    "label": "Archivo-550",
    "groupLabel": "Archivo-600",
    "title": "Archivo-620",
    "heading": "Archivo-650",
    "emptyHeading": "Archivo-680"
  },
  "articleTitle": "Archivo-750",
  "display": "ArchivoExpanded-750",
  "mono": "MartianMono-500",
  "reader": {
    "regular": "Literata-18-400",
    "italic": "Literata-18-400-Italic",
    "bold": "Literata-18-700"
  },
  "readerWord": {
    "regular": "Literata-32-400",
    "focus": "Literata-32-600"
  }
} as const;

/** The cuts the font build makes from the variable faces (fontTools varLib.instancer), keyed by family. */
export const fontCuts = {
  "Archivo-400": {
    "source": "Archivo",
    "wght": 400,
    "wdth": 100
  },
  "Archivo-500": {
    "source": "Archivo",
    "wght": 500,
    "wdth": 100
  },
  "Archivo-550": {
    "source": "Archivo",
    "wght": 550,
    "wdth": 100
  },
  "Archivo-600": {
    "source": "Archivo",
    "wght": 600,
    "wdth": 100
  },
  "Archivo-620": {
    "source": "Archivo",
    "wght": 620,
    "wdth": 100
  },
  "Archivo-650": {
    "source": "Archivo",
    "wght": 650,
    "wdth": 100
  },
  "Archivo-680": {
    "source": "Archivo",
    "wght": 680,
    "wdth": 100
  },
  "Archivo-750": {
    "source": "Archivo",
    "wght": 750,
    "wdth": 100
  },
  "ArchivoExpanded-750": {
    "source": "Archivo",
    "wght": 750,
    "wdth": 125
  },
  "MartianMono-500": {
    "source": "Martian Mono",
    "wght": 500
  },
  "Literata-18-400": {
    "source": "Literata",
    "wght": 400,
    "opsz": 18
  },
  "Literata-18-400-Italic": {
    "source": "Literata Italic",
    "wght": 400,
    "opsz": 18
  },
  "Literata-18-700": {
    "source": "Literata",
    "wght": 700,
    "opsz": 18
  },
  "Literata-32-400": {
    "source": "Literata",
    "wght": 400,
    "opsz": 32
  },
  "Literata-32-600": {
    "source": "Literata",
    "wght": 600,
    "opsz": 32
  }
} as const;

/** UI text: the family for a weight role at one of the scale's sizes, with line height and spacing in px. */
export type UiWeight = keyof typeof fontFamily.ui;
export type UiSize = (typeof type.ui.sizes)[number];
export function uiText(size: UiSize, weight: UiWeight) {
  return { fontFamily: fontFamily.ui[weight], fontSize: size, lineHeight: size * type.ui.lineHeight, letterSpacing: 0 };
}

/** Reader body text at the Aa sheet's size (reader.sizeRange); the cut stays at its fixed optical size. */
export function readerText(size: number = reader.size, face: keyof typeof fontFamily.reader = 'regular') {
  return { fontFamily: fontFamily.reader[face], fontSize: size, lineHeight: size * reader.lineHeight, letterSpacing: 0 };
}

export const type = {
  "ui": {
    "sizes": [
      13,
      15,
      17,
      20,
      28,
      32
    ],
    "lineHeight": 1.45
  },
  "display": {
    "28": {
      "fontFamily": "ArchivoExpanded-750",
      "fontSize": 28,
      "lineHeight": 33.6,
      "letterSpacing": -0.7
    },
    "32": {
      "fontFamily": "ArchivoExpanded-750",
      "fontSize": 32,
      "lineHeight": 38.4,
      "letterSpacing": -0.8
    }
  },
  "articleTitle": {
    "fontFamily": "Archivo-750",
    "fontSize": 28,
    "lineHeight": 33.6,
    "letterSpacing": -0.616
  },
  "mono": {
    "fontFamily": "MartianMono-500",
    "fontSize": 13,
    "lineHeight": 18.85,
    "letterSpacing": -0.39
  },
  "readerWord": {
    "fontFamily": "Literata-32-400",
    "fontSize": 32,
    "lineHeight": 35.2,
    "letterSpacing": 0
  }
} as const;

export const space = {
  "4": 4,
  "8": 8,
  "12": 12,
  "16": 16,
  "20": 20,
  "24": 24,
  "32": 32
} as const;
export const gap = {
  "card": 10
} as const;
export const radius = {
  "image": 4,
  "control": 8,
  "button": 12,
  "container": 14,
  "sheet": 20,
  "pill": 999,
  "use": "4 covers in lists and article images. 8 chips, segments, the active tab tile, the speed pill and cover play buttons. 12 buttons, fields and icon buttons. 14 every card and group, players, the toast and Archive. 20 sheets, illustrations and the viewfinder. Pill only for genuinely round ends: play discs, switch tracks, progress lines and dots."
} as const;
export const focus = {
  "width": 2,
  "offset": 2
} as const;
export const icons = {
  "stroke": 1.75,
  "customDigitStroke": 1.3125
} as const;

/** Motion (docs/design/motion-spec.md). Easings are cubic Bézier tuples or 'linear'; release is the one spring. */
export const motion = {
  "enter": {
    "duration": 250,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ]
  },
  "exit": {
    "duration": 200,
    "easing": [
      0.4,
      0,
      1,
      1
    ]
  },
  "quickIn": {
    "duration": 150,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ]
  },
  "quickOut": {
    "duration": 100,
    "easing": [
      0.4,
      0,
      1,
      1
    ]
  },
  "reflow": {
    "duration": 200,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ]
  },
  "press": {
    "listDelay": 60,
    "out": {
      "duration": 100,
      "easing": [
        0.4,
        0,
        1,
        1
      ]
    },
    "layer": {
      "page": 0.08,
      "fill": 0.12,
      "reader": 0.08
    }
  },
  "mark": {
    "duration": 200,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ],
    "fromScale": 0.4,
    "fromOpacity": 0
  },
  "release": {
    "mass": 1,
    "stiffness": 439,
    "damping": 42,
    "overshootClamping": true
  },
  "draw": {
    "duration": 520,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ],
    "stagger": 34
  },
  "catchUp": {
    "duration": 400,
    "easing": [
      0.2,
      0.8,
      0.2,
      1
    ],
    "delay": 150,
    "threshold": 0.02,
    "finish": {
      "duration": 200,
      "easing": [
        0.2,
        0.8,
        0.2,
        1
      ],
      "delay": 100
    }
  },
  "countdown": {
    "toast": 5000,
    "share": 4000,
    "extension": 8000
  },
  "ambient": {
    "delay": 150,
    "breathe": {
      "duration": 1200,
      "easing": [
        0.42,
        0,
        0.58,
        1
      ],
      "opacity": [
        0.3,
        1
      ],
      "phase": 200
    },
    "pulse": {
      "duration": 1400,
      "easing": [
        0.42,
        0,
        0.58,
        1
      ],
      "opacity": [
        0.55,
        1
      ]
    },
    "sweep": {
      "duration": 1200,
      "easing": [
        0.42,
        0,
        0.58,
        1
      ],
      "segment": 0.3
    },
    "scan": {
      "duration": 1800,
      "easing": [
        0.42,
        0,
        0.58,
        1
      ]
    },
    "eq": {
      "duration": 1000,
      "easing": [
        0.42,
        0,
        0.58,
        1
      ]
    }
  },
  "launch": {
    "hold": 5000,
    "in": {
      "duration": 400,
      "easing": [
        0.2,
        0.8,
        0.2,
        1
      ],
      "delay": 150
    },
    "out": {
      "duration": 300,
      "easing": [
        0.4,
        0,
        1,
        1
      ]
    }
  }
} as const;
