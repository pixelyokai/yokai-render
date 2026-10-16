---
name: yokai-render
description: "Render any web page, component, CSS/canvas animation or WebGL shader to a frame-perfect video (MP4, ProRes with alpha, or PNG frames) by stepping a virtual clock and screenshotting every frame, instead of screen recording. Can also play a scripted walkthrough (typing, clicks, keys, with a visible pointer) for product demos. Use when someone wants a video, clip, GIF source, loop or frames of something running in a browser and quality matters: posting UI experiments to X/Instagram/Dribbble, product demo clips, portfolio reels, transparent overlays for editing. Triggers on: record this, render to video, export as mp4, make a clip, demo video, product walkthrough, screen recording looks bad, dropped frames, stutter, choppy recording, blurry recording, 60fps video, 4K video, ProRes, transparent video, alpha channel, loop video, letterbox, 16:9, MediaRecorder, getDisplayMedia, OBS, puppeteer video, headless capture."
---

# Yokai Render

Never screen-record a web animation when quality matters. Render it.

Screen recording runs in real time: any frame the page can't produce in 16.6ms is dropped or duplicated, capture is limited to the monitor's pixels and then rescaled, and the real-time encoder trades quality for speed. No setting fixes that. `scripts/render.mjs` takes over the page's clock instead (rAF, `performance.now`, `Date`, timers, CSS and Web Animations), advances it exactly one frame, takes a lossless screenshot at 2x density and pipes it to ffmpeg. A shader that needs 200ms per frame still comes out as perfect 60fps.

`node scripts/render.mjs --help` prints every option.

## 1. Check prerequisites

Run `node -v` and `ffmpeg -version`.

- Node below 22 → stop and tell the user to upgrade. The script uses Node's built-in WebSocket.
- ffmpeg missing → tell the user how to install it (`winget install Gyan.FFmpeg`, `brew install ffmpeg`, `apt install ffmpeg`), or set `FFMPEG_PATH`.
- Chrome is found automatically. If it isn't, set `CHROME_PATH` to Chrome or Chromium.

## 2. Pick the target

```
Is the page already served over http(s)?
├── Yes → pass the URL. For an app with a dev server, prefer a production
│         build (next start, vite preview…): dev overlays and badges show up in frames.
└── No, it's a local file
    ├── Uses ES modules, fetch(), workers or relative imports?
    │   └── Yes → serve the folder (npx http-server -p 5173 -c-1) and pass the http URL.
    │             file:// blocks these, so the page renders broken or blank.
    └── Plain HTML/CSS/inline JS → pass the file path directly
```

Before rendering, read the page source for anything the virtual clock can't control (step 9). Fix it or warn the user first, so you don't find out after a full render.

Each render starts from a clean profile and clears the site's storage, so state saved by a previous run (localStorage, IndexedDB) never leaks into the next one.

## 3. Set the environment, not the page

Don't edit the user's page to force a look. Use the flags:

- `--color-scheme dark|light` emulates `prefers-color-scheme`. Headless Chrome defaults to light.
- `--timezone America/New_York` emulates a time zone (IANA name). Matters for anything showing times or dates. Default is the machine's zone.

## 4. Make it move: `--script`

The renderer sends no real input, so hover, click and typing states never happen on their own. Write a walkthrough script instead of editing the page. It runs after warmup, so script time 0 is video time 0, and every wait follows the virtual clock.

The script is the body of an async function with these in scope:

| Helper | Does |
|---|---|
| `sleep(ms)` | Waits on the virtual clock |
| `$(sel)`, `$$(sel)` | `querySelector` / `querySelectorAll` (array) |
| `byText(text, selector?)` | First button, link, option, menu item or label containing `text` |
| `waitFor(selector \| fn, timeout?)` | Resolves when it exists / returns truthy; throws after `timeout` (5000ms) |
| `click(target, { ms, pointer })` | Glides the pointer there, presses, then fires the full pointerdown → mousedown → focus → pointerup → mouseup → click sequence |
| `type(text, { perChar, into })` | Types character by character through real input events; `into` focuses a field and puts the caret at the end first |
| `key(name, init?, target?)` | keydown + keyup, e.g. `key('Enter')`, `key('k', { metaKey: true, ctrlKey: true })` |
| `caretToEnd(el)` | Focus and move the caret to the end |
| `pointer.place(x, y, ms)`, `pointer.moveTo(el)`, `pointer.press()`, `pointer.hide()` | Drive the visible pointer without clicking |

```js
// walkthrough.js
const search = await waitFor('input[type="search"]');
await click(search);
await type('pricing', { into: search });
key('Enter');
await click(await waitFor(() => byText('Read more')));
```

What synthetic events can't do: browser defaults don't run (`key('Enter')` won't submit a form by itself, arrow keys won't scroll), and `:hover` styles don't apply. Drive the app's own handlers, which is what most UI libraries listen to anyway.

If the script throws (an element is missing, `waitFor` times out), the render stops with the reason and deletes the partial file, rather than producing a wrong video. Read that message, fix the selector or timing, and re-run.

## 5. Pick size, fit and scale

`--size` is the viewport in CSS px. Output pixels are size × `--scale`.

| Destination | `--size` | Output at `--scale 2` |
|---|---|---|
| X / Instagram feed (4:5, default) | 1080x1350 | 2160x2700 |
| Reels / TikTok / Stories (9:16) | 1080x1920 | 2160x3840 |
| YouTube / landscape (16:9) | 1920x1080 | 3840x2160 (4K) |
| Square | 1080x1080 | 2160x2160 |

The viewport sets the layout: a 1080px-wide viewport lays out like a 1080px-wide browser window. If the content looks wrong at the target size (too small, cramped, breakpoint flips), change the width to fit the content. Don't use `--scale` for this, because scale changes sharpness, not layout.

**Nothing cut off.** When the content is taller than the viewport at any point (a page that grows as the script runs, a dialog, a toast), add `--fit`. It plays the whole timeline once without screenshots (fast), measures the tallest the page and its overlays get, and grows the viewport height to match.

**Exact aspect ratio without cropping.** `--pad 16:9` pads the video to that ratio, centred, in the same encode. `--pad-color auto` (default) samples the page background so the bars are invisible; pass `#rrggbb` to override, or `transparent` with `--transparent`. `--fit --pad 16:9` is the usual pair for a landscape product demo: pick a sensible width, let fit choose the height, let pad make it 16:9.

- Always keep `--scale 2`. 1x frames show aliased edges on thin lines and text.
- If the upload will be downscaled anyway (X caps video around 1920px), add `--out-scale 0.5` for a supersampled 1x output. A Lanczos downscale of 2x frames is visibly cleaner than rendering at 1x.

## 6. Pick the format

```
Will it be edited or composited (After Effects, Premiere, Resolve, Final Cut)?
├── Yes → --format prores   (ProRes 4444, keeps alpha)
│   └── Needs a transparent background? → add --transparent
└── No, posting or sharing directly
    ├── Saturated colours or thin coloured edges, and the viewer uses VLC/an editor, not Safari/iOS?
    │   └── --format mp4-444   (full-resolution colour; Safari won't play it)
    └── Default → --format mp4   (H.264 4:2:0, CRF 10, plays everywhere)
Need individual frames (GIF, sprite sheet, custom pipeline)? → --format png
```

- `--transparent` makes `html` and `body` transparent and turns off Chrome's white default. Any wrapper element that paints its own background stays opaque. Check the source and tell the user which element to change.
- `--transparent` only works with `prores` or `png` (the script refuses mp4: H.264 has no alpha).
- `--crf 0` is lossless. Use it for an intermediate you'll process further, not for upload: files are large and some players (Safari, QuickTime) won't open lossless H.264.

## 7. Pick duration and warmup

- **Looping animation:** find the loop period in the source (CSS `animation-duration`, a GSAP timeline, a `t % period` in a shader). Set `--duration` to an exact multiple of it so the video loops seamlessly. Tell the user if you couldn't find a period.
- **Intro then idle:** the default `--warmup 1.5` simulates 1.5s before frame 0 so loaders and fade-ins have finished. To capture the intro itself, use `--warmup 0`.
- **Walkthrough:** time the script, then set `--duration` to its length plus a 1–2s rest at the end. A short `--warmup 0.2` keeps the first frame close to the page as loaded.
- **Default:** 8s at 60fps. Use `--fps 30` only when asked. 60 is what makes motion look smooth.

## 8. Smoke test, render, then verify

Rendering runs at roughly 5–15 frames per second, so 30s at 60fps takes 2–6 minutes. Don't spend that finding out a flag was wrong:

1. **Smoke render first:** the same command with `--duration 2` (or the first few seconds of a script). Check one frame from it. It catches wrong sizes, colours, fonts, a failing script and padding problems in seconds.
2. **Full render**, in the background if your harness supports that:
   ```
   node <skill-dir>/scripts/render.mjs <target> --size 1280x720 --fit --pad 16:9 --duration 30 --script walkthrough.js --color-scheme dark
   ```
3. **Never report success from the exit code alone:**
   - Read the "Page errors" and "Console errors" lines, if any. An error usually means a feature broke, not just a log message.
   - Extract three or more frames (start, middle, end, plus each scripted beat) and look at them:
     `ffmpeg -v error -ss <sec> -i out.mp4 -frames:v 1 check-<sec>.png`
   - Compare against the failure table below. Re-render if any row matches.
4. Report the output path, resolution, duration, fps and format to the user, and anything you changed or assumed.

## 9. Failure table

| Symptom in frames | Cause | Fix |
|---|---|---|
| Blank, spinner or half-faded first frame | Assets or intro not done before frame 0 | Raise `--warmup` to 3–5 |
| Part of the page frozen while the rest moves | It's driven by a clock the shim doesn't control: Web Worker or OffscreenCanvas in a worker, `<video>`, `document.timeline.currentTime`, or `event.timeStamp` | Drive it from `requestAnimationFrame` / `performance.now` in the main thread, or warn the user that this part won't animate |
| Motion jumps or runs at the wrong speed | Code measures real time between frames (e.g. capping delta from a cached real timestamp) | Make its delta come from the rAF timestamp argument |
| Video plays but nothing moves | Animation only starts on hover, click or scroll | Write a `--script` that triggers it |
| "Your --script failed" | A selector didn't match, or something wasn't there yet | Use `waitFor` before acting; check the selector against the page in a normal browser |
| Bottom of the page, a dialog or a toast cut off | Content taller than the viewport | Add `--fit` |
| Black bars | Aspect ratio fixed outside the renderer | Use `--pad R` here instead, so the bars match the page |
| Light theme when dark was wanted, or wrong times | Headless defaults | `--color-scheme dark`, `--timezone …` |
| Dev overlay or "N" badge in frames | Rendering a dev server | Render a production build |
| Black or empty WebGL canvas | GPU unavailable in headless Chrome (common on Linux servers and CI) | Run on a machine with a GPU. The software fallback is very slow and may render differently. |
| Fallback font | Font loaded after `document.fonts.ready`, or blocked under file:// | Serve over http, or preload the font |
| "Can't reach …" / "never finished loading" | Wrong URL, server not running, or a Content-Security-Policy blocking the injected clock | Start the server and check the URL in a browser; relax the CSP for the render |

## Never

- **Never fall back to MediaRecorder, getDisplayMedia, OBS or Puppeteer's screencast** "because it's faster". They're real-time captures and have the exact problems this skill exists to avoid. If rendering is impossible, say so and explain why.
- **Never lower `--scale` or raise `--crf` to save time or disk space** without asking. Quality is the reason the user is here.
- **Never edit the user's page just to make the render work** without saying so. Prefer `--script`, `--color-scheme`, `--timezone`, `--fit` and `--pad`, which need no page changes. If a page change is truly needed, tell them what you changed and where.
