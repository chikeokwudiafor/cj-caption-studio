# Clip Captioner — The Village PGH × FTK

Add branded captions to short video clips and export them ready for Instagram and
TikTok. Everything runs in the browser: clips are never uploaded anywhere.

Live: https://chikeokwudiafor.github.io/cj-caption-studio/

## Files

| File | What it does |
| --- | --- |
| `index.html` | Markup and the app shell |
| `styles.css` | All styling. Mobile-first; the desktop three-pane layout is one `@media (min-width: 900px)` block at the bottom |
| `app.js` | State, rendering, gestures, export orchestration |
| `autocut.js` | Finds the good moments and assembles a draft cut (`window.AutoCut`) |
| `captions-engine.js` | Caption templates, and the MediaRecorder fallback export (`window.CaptionEngine`) |
| `mp4-export.js` | Fast WebCodecs encode plus a hand-written MP4 muxer (`window.FastExport`) |
| `store.js` | IndexedDB session persistence (`window.Store`) |
| `sw.js` | Offline cache |
| `fonts/`, `fonts.css` | Self-hosted fonts, so there are no external requests |
| `manifest.webmanifest`, `icon*.png/svg` | Add-to-home-screen support |

## How auto-build works

There is no model and no network call. For event footage the good moments are
measurable, so `autocut.js` measures them:

1. **Audio energy** across every clip — an RMS envelope at 10 samples a second,
   decoded at 22kHz mono because that is plenty for an envelope and much faster.
   The loudest sustained window is almost always the moment worth keeping.
2. **Tempo**, by autocorrelating the onset flux between 90 and 180 BPM. When the
   footage has a steady beat, segment lengths are rounded to whole beats so cuts
   land with the music.
3. **Motion**, as the mean absolute frame difference at 64x36. This needs a video
   seek per sample, so it only runs on the two or three windows that already
   scored well on audio.

Clips scoring under 28% of the best one are left out of the cut rather than
padding it. Nothing is deleted — excluded clips stay in the rail marked `out`,
and the `+` button on a clip card puts one back.

No build step, no bundler, no framework. Edit a file, commit, push — GitHub Pages
serves it directly. The only external request is the Google Fonts stylesheet, and
it loads non-blocking so the app is usable before the fonts arrive.

After changing `app.js`, `styles.css`, or `captions-engine.js`, bump the `?v=`
number on that file's tag in `index.html` so returning phones don't run a cached
copy.

## Adding a caption template

Templates live in the `TEMPLATES` object in `captions-engine.js`. Each one declares
its editable fields and a `render(ctx, env)` that draws onto the canvas:

```js
myTemplate: {
  name: 'My template',
  backdrop: 'fade',              // 'none' | 'fade' | 'dim'
  fields: [
    { id: 'headline', label: 'Headline', def: 'HELLO', multi: false }
  ],
  render(ctx, env) {
    const { W, H, u, brand, vals, t } = env;
    // u scales everything to the frame size, so draw in 1080-wide units and
    // multiply by u. t is seconds since the caption appeared — use it to animate.
  }
}
```

The panel UI builds itself from `fields`, so nothing else needs touching.

`u` matters: the preview canvas is sized to the phone's actual display, not to
1080×1920, so a phone is not shading two megapixels per frame just to show a
preview. Export still renders at full resolution.

## Export notes

There are two export paths and the app picks automatically.

**Fast path (`mp4-export.js`).** WebCodecs encodes H.264 and AAC, and the muxer in
that file writes the MP4 boxes by hand — nothing built into the browser will wrap
encoded chunks into a container. It runs several times faster than the clip is
long and does not stop when the tab is backgrounded. Because the muxer is ours,
every file is decoded back and duration-checked before it is offered.

**Fallback (`captions-engine.js`).** If WebCodecs is missing, or the fast path
fails verification, the app records a canvas with `MediaRecorder`. That runs in
real time and the tab has to stay in front, so the app holds a screen wake lock
and warns when a recording came out truncated.

Canvas capture needs iOS 15 or later; the fast path needs Safari 16.4+.

## Local preview

```bash
python3 -m http.server 4173 --directory .
```

Then open http://localhost:4173.
