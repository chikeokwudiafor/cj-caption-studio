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
| `captions-engine.js` | Caption templates and the canvas/MediaRecorder export pipeline (`window.CaptionEngine`) |
| `manifest.webmanifest`, `icon*.png/svg` | Add-to-home-screen support |

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

Export plays the clip through a canvas and records it with `MediaRecorder`, so it
runs in real time — a 30 second clip takes about 30 seconds, and the tab has to
stay in front.

MP4 (H.264) is picked when the browser supports it: Chrome, and Safari from
iOS 17.4 / macOS 14.4. Older Safari can only produce WebM, which Instagram and
TikTok may reject; the Export panel says so when that is the case.

Canvas capture needs iOS 15 or later.

## Local preview

```bash
python3 -m http.server 4173 --directory .
```

Then open http://localhost:4173.
