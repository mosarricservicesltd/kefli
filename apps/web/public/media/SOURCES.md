# Option A assets: where they came from

Generated on 9 October 2026 with Higgsfield, on Richard's account. No real place is depicted, and there are no people, buildings or marks.

| File | Made from |
|---|---|
| `loop-1920.mp4`, `loop-1280.mp4` | Seedance 2.5 (job `7b5d4972-9f03-4f70-82f6-71e1868c6b6e`), image to video, 10 s at 21:9, with the plate below as both first and last frame and a locked-off camera, so only the cloud sea moves. Re-encoded to H.264 with the last second crossfaded into the first, so the loop has no seam (9 s). |
| `plate-*.avif`, `plate-*.webp`, `plate-2206.jpg` | The loop's first frame (2206 × 946). The still under the video, and the whole hero under reduced motion. |
| `ridge-*.webp` | The near ridge cut out of that same frame by brightness (rock below 48 of 255 after a light blur, scanned up from the bottom of each column, notches closed). Same size as the plate, so it lines up exactly. |
| (source, not shipped) | Cinema Studio 2.5 (job `18d9ba0a-ecef-4656-9229-c2077f2d05f9`), 21:9 at 4K: the plate the loop was made from. Its sibling, job `f711b68b-…`, was rejected for its warm peach horizon. |

## The dusk above the footer

| File | Made from |
|---|---|
| `dusk-loop-1920.mp4`, `dusk-loop-1280.mp4` | Seedance 2.5 (job `c08ed4fd-f82c-4b38-b9cc-ad66fac5ec77`), made the same way as the summit loop: the dusk plate as first and last frame, locked-off camera, the last second crossfaded into the first. |
| `dusk-*.avif`, `dusk-*.webp`, `dusk-2206.jpg` | That loop's first frame: the still under the video, and the scene under reduced motion. |
| (source, not shipped) | Cinema Studio 2.5 (job `ef11bca9-e308-44f6-95d7-2917a44fd8b0`), 21:9 at 4K, made with the summit plate as its reference image: the same view about forty minutes after sunset. Its sibling, `dbbfad16-…`, was the lighter of the two and wasn't used. |

The visual system every asset follows: granite peaks breaking a sea of cloud, seen from a summit at first light; low dawn sun behind thin haze; a long telephoto feel with fine grain; graded towards ink, paper and cold silver with only a whisper of warmth at the sun. Quiet, vast, enduring.

The crest profile in the page (`CREST`) is measured from the ridge cut and must be regenerated with it.

## The app beside How it works

| File | Made from |
|---|---|
| `../../src/media/app-save-*.webp`, `app-read-*.webp`, `app-speed-*.webp`, `app-listen-*.webp` (kept in `src/media`, not here, so the build hashes their names and a new screenshot never sits behind a browser's year-long copy of the old one) | The store screenshots in `apps/mobile/store/screenshots/` (`3-library`, `4-reader`, `5-speedread`, `7-listen`): release 1.0.0 on a Pixel 10a in Android's demo mode, 16 October 2026, the notification shade cleared first. Scaled to 360 and 720 pixels wide as WebP by `apps/web/scripts/app-images.mjs` (headless Chrome). Rerun it after each new set. |
