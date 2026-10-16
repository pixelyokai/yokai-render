# yokai-recorder

Frame-perfect videos of anything that runs in a browser, made by your coding agent.

![Claude Code](https://img.shields.io/badge/Claude_Code-Skill-purple)
![Cursor](https://img.shields.io/badge/Cursor-Compatible-blue)
![Codex](https://img.shields.io/badge/Codex-Compatible-black)
![60fps](https://img.shields.io/badge/output-60fps%20%C2%B7%204K%20%C2%B7%20ProRes-ff5a36)

This repo holds one skill, **yokai-render**. Point it at a page, a component, a CSS or canvas animation, a WebGL shader or a whole web app, and it gives you an MP4, a ProRes file with transparency, or a folder of PNG frames. It can also play a scripted walkthrough (typing, clicks, key presses, with a visible pointer) for product demos, without touching your app's code.

```bash
npx skills add pixelyokai/yokai-recorder
```

## Why it exists

Screen recordings of UI work look worse than the real thing. You get dropped frames, soft pixels and mushy compression, and no setting fixes it, because a recorder runs in real time. Any frame the page can't draw in 16.6ms gets dropped or doubled, the capture is limited to your monitor's pixels, and the encoder trades quality for speed.

yokai-render doesn't record. It renders. It takes over the page's clock (`requestAnimationFrame`, `performance.now`, `Date`, timers, CSS and Web Animations), moves it forward exactly one frame, takes a lossless screenshot at 2× density, and pipes it to ffmpeg. Time only moves when the renderer says so. A shader that needs 200ms per frame still comes out as a perfect 60fps video.

The name says recorder because that's what people ask for. What you get is better than a recording.

## What you can make with it

- A crisp 60fps clip of a UI experiment for X, Instagram or Dribbble
- A 30-second product demo where the cursor types, clicks and opens things, in exact 16:9 with no black bars
- A seamless loop of a shader or a CSS animation
- A transparent ProRes overlay to drop into After Effects, Premiere, Resolve or Final Cut
- PNG frames for a GIF, a sprite sheet or your own pipeline

## When to use it, and when not to

| Use it when | Use something else when |
|---|---|
| Quality matters and the video will be seen by other people | You need a quick throwaway capture for a bug report. Your OS screen recorder is faster. |
| The page drops frames live: heavy shaders, big DOM, slow laptop | It isn't in a browser: native apps, games, terminal sessions |
| You want 60fps, 4K, ProRes or transparency | You need sound. The renderer makes no audio; add it in an editor afterwards. |
| You want the same video every time (re-render after a design tweak) | Something important on screen is driven by a Web Worker, `OffscreenCanvas` in a worker, or a `<video>` element. Those run on their own clock and will freeze. |
| You're making a demo and want the cursor, typing and clicks to look perfect | You need real hover styles, native form behaviour, or input from a real person (drag-and-drop with physics, drawing). Script input is synthetic. |
| | The clip is several minutes long and you need it now. Rendering runs at roughly 5 to 15 frames per second, so 30 seconds at 60fps takes 2 to 6 minutes. |
| | You're on a machine without a GPU (most CI runners) and the page uses WebGL. It falls back to slow software rendering. |

## Install

### With the skills CLI (recommended)

Works with Claude Code, Cursor, Codex, Windsurf, Copilot and [40+ other agents](https://github.com/vercel-labs/skills#supported-agents):

```bash
npx skills add pixelyokai/yokai-recorder
```

The CLI detects your agent. To pick one, add `--agent`, for example `--agent claude-code`.

### By hand

Clone the repo and copy `skills/yokai-render` into your agent's skills folder:

| Agent | Skills folder |
|---|---|
| Claude Code | `~/.claude/skills/` (all projects) or `.claude/skills/` (one project) |
| Cursor | `~/.cursor/skills/` |
| OpenAI Codex | `~/.codex/skills/` |
| OpenCode | `~/.config/opencode/skills/` |

```bash
git clone https://github.com/pixelyokai/yokai-recorder
cp -r yokai-recorder/skills/yokai-render ~/.claude/skills/
```

### Requirements

- **Node 22 or newer** (it uses Node's built-in WebSocket)
- **Google Chrome or Chromium.** Found automatically; set `CHROME_PATH` if not.
- **ffmpeg:** `winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on macOS, `apt install ffmpeg` on Linux. Set `FFMPEG_PATH` if it isn't on your PATH.

### Check it works

The repo includes a tiny demo page and walkthrough. From the repo folder:

```bash
node skills/yokai-render/scripts/render.mjs examples/demo.html \
  --script examples/demo-walkthrough.js --size 720x720 --fit --pad 16:9 --duration 8
```

You should get a video in `renders/` of a cursor typing two tasks into a todo card.

## Using it

Ask your agent in plain words. The skill picks the settings, renders a short test first, then the full video, and checks frames from it before telling you it's done.

> Render components/hero/index.html as a 4:5 video for X.

> Make a 30 second 16:9 demo of localhost:3000 in dark mode. Type "pricing" in the search, open the first result, then scroll to the plans.

> Export this shader as a transparent ProRes loop.

> Render the onboarding screen at 9:16 for Reels, with the times shown in New York.

You can also run it yourself:

```bash
node skills/yokai-render/scripts/render.mjs <url or file.html> [options]
```

## The steps, start to finish

This is what the skill does, in order. Follow the same steps if you run the script by hand.

1. **Check the tools.** Node 22+, Chrome, ffmpeg.
2. **Pick the target.** A URL, or a local HTML file. If a local file uses ES modules, `fetch()` or workers, serve the folder first (`npx http-server -p 5173 -c-1`), because `file://` blocks those. For a web app, render a production build (`next start`, `vite preview`); dev servers put overlays and badges in the frames.
3. **Read the page for things the clock can't control** (Web Workers, `<video>`, code that measures real time). Fix them or know they'll freeze, before spending minutes on a render.
4. **Set the environment, not the page.** `--color-scheme dark` and `--timezone Europe/Berlin` instead of editing the app.
5. **Write a walkthrough** if anything needs to happen: typing, clicks, opening menus. See [Walkthrough scripts](#walkthrough-scripts).
6. **Pick the size.** `--size` is the browser window in CSS pixels and decides the layout. Keep `--scale 2` for sharp edges.
7. **Make sure nothing is cut off.** Add `--fit` when the page, a dialog or a toast could be taller than the window. It plays the timeline once without screenshots, measures, and grows the window to match.
8. **Get the exact aspect ratio.** `--pad 16:9` pads the video to that ratio using the page's own background colour, so there are no visible bars and nothing is cropped or stretched.
9. **Pick the format.** `mp4` to post, `mp4-444` for full colour in an editor, `prores` for compositing and transparency, `png` for frames.
10. **Pick the length.** For a loop, an exact multiple of the loop period. For a walkthrough, the script's length plus a second or two of rest.
11. **Smoke test.** Run the same command with `--duration 2` and look at one frame. It catches a wrong size, colour, font or a failing script in seconds.
12. **Render for real**, in the background if you can.
13. **Check the result.** Read any "Page errors" or "Console errors" lines, then pull a few frames and look at them:
    `ffmpeg -v error -ss 4 -i out.mp4 -frames:v 1 check.png`

## Options

| Option | Default | What it does |
|---|---|---|
| `--size WxH` | `1080x1350` | Browser window in CSS px; sets the layout |
| `--scale N` | `2` | Pixel density. Frames are W×N by H×N |
| `--out-scale N` | `1` | Downscale the encode. `0.5` gives a supersampled 1× video, cleaner than rendering at 1× |
| `--fps N` | `60` | Frames per second |
| `--duration S` | `8` | Seconds to render |
| `--warmup S` | `1.5` | Seconds to let the page settle before frame 0. Use `0` to capture an intro |
| `--format` | `mp4` | `mp4`, `mp4-444`, `prores` or `png` |
| `--crf N` | `10` | x264 quality, lower is better. `0` is lossless (for intermediates; some players won't open it) |
| `--transparent` | off | Transparent page background. Needs `prores` or `png` |
| `--color-scheme` | system | `light` or `dark` |
| `--timezone TZ` | system | Any IANA name, like `America/New_York` |
| `--script FILE` | none | Play a walkthrough on the virtual clock |
| `--fit` | off | Grow the window height so nothing gets cut off |
| `--pad R` | off | Pad to an aspect ratio, like `16:9`, `9:16` or `4:5` |
| `--pad-color C` | `auto` | `auto` (page background), `#rrggbb`, or `transparent` |
| `--out PATH` | `renders/…` | Output file, or a folder for `png` |

`--help` prints the same list.

### Sizes for common places

| Destination | `--size` | Output at `--scale 2` |
|---|---|---|
| X or Instagram feed (4:5) | `1080x1350` | 2160×2700 |
| Reels, TikTok, Stories (9:16) | `1080x1920` | 2160×3840 |
| YouTube or landscape (16:9) | `1920x1080` | 3840×2160 (4K) |
| Square | `1080x1080` | 2160×2160 |

For a web app that doesn't fill a landscape screen nicely, pick a comfortable width, add `--fit --pad 16:9`, and let the renderer work out the rest. X caps video at about 1920px wide, so `--out-scale 0.5` is worth adding for posts.

## Walkthrough scripts

The renderer can't use a real mouse or keyboard, so hover, click and typing states never happen on their own. A walkthrough script makes them happen. It runs once the page is ready, so script time 0 is video time 0, and every wait follows the virtual clock.

A script is the body of an async function. These helpers are in scope:

| Helper | What it does |
|---|---|
| `sleep(ms)` | Wait, on the virtual clock |
| `$(sel)`, `$$(sel)` | `querySelector`, and `querySelectorAll` as an array |
| `byText(text, selector?)` | The first button, link, menu item, option or label containing `text` |
| `waitFor(selector or fn, timeout?)` | Wait until it exists or returns something truthy. Fails after 5 seconds by default |
| `click(target, { ms, pointer })` | Glide the pointer there, press, and fire a full pointer and mouse click |
| `type(text, { perChar, into })` | Type one character at a time through real input events. `into` focuses a field first |
| `key(name, init?, target?)` | Key down and up, like `key('Enter')` or `key('k', { metaKey: true })` |
| `caretToEnd(el)` | Focus a field and put the caret at the end |
| `pointer.place(x, y, ms)`, `pointer.moveTo(el)`, `pointer.press()`, `pointer.hide()` | Move the visible pointer without clicking |

```js
// walkthrough.js
const search = await waitFor('input[type="search"]');
await click(search);
await type('pricing', { into: search });
key('Enter');
await click(await waitFor(() => byText('Read more')));
pointer.place(innerWidth * 0.7, innerHeight * 0.6, 800);
```

Things to know:

- Events are synthetic. Your app's own handlers run, but browser defaults don't: `key('Enter')` won't submit a form by itself, arrow keys won't scroll, and `:hover` styles won't apply.
- Use `waitFor` before acting on anything that appears after a delay.
- If the script fails (a selector doesn't match, `waitFor` times out), the render stops, tells you why, and deletes the half-written video. You never end up with a wrong video that looks finished.

## Recipes

**Product demo for X, 16:9, dark**

```bash
node skills/yokai-render/scripts/render.mjs http://localhost:3000 \
  --size 1280x720 --fit --pad 16:9 --out-scale 0.5 \
  --color-scheme dark --script demo.js --warmup 0.2 --duration 30
```

**Seamless loop of a CSS animation with a 2s period**

```bash
node skills/yokai-render/scripts/render.mjs loader.html --size 1080x1080 --duration 6
```

**Transparent overlay for video editing**

```bash
node skills/yokai-render/scripts/render.mjs badge.html --format prores --transparent --duration 4
```

**Frames for a GIF**

```bash
node skills/yokai-render/scripts/render.mjs effect.html --format png --fps 30 --duration 3
```

## When something looks wrong

| You see | Why | Fix |
|---|---|---|
| A blank or half-faded first frame | Assets or an intro weren't done before frame 0 | Raise `--warmup` to 3 to 5 |
| One part frozen while the rest moves | It's on a clock the renderer can't control (worker, `<video>`) | Drive it from `requestAnimationFrame` on the main thread |
| Motion jumps or runs at the wrong speed | The code measures real time between frames | Use the timestamp `requestAnimationFrame` passes in |
| Nothing moves | The animation waits for hover, a click or a scroll | Add a `--script` that triggers it |
| Bottom of the page, a dialog or a toast cut off | Content taller than the window | Add `--fit` |
| Black bars | The ratio was fixed outside the renderer | Use `--pad` instead |
| Light mode or wrong times | Headless Chrome defaults | `--color-scheme`, `--timezone` |
| A dev badge in the corner | You rendered a dev server | Render a production build |
| Black WebGL canvas | No GPU (common in CI) | Render on a machine with a GPU |
| A fallback font | The font loaded late, or `file://` blocked it | Serve over http, or preload the font |

The skill's own instructions, with more detail on every step, are in [skills/yokai-render/SKILL.md](skills/yokai-render/SKILL.md).

## How it works

1. Starts headless Chrome on your real GPU, with a clean profile.
2. Installs a virtual clock before any of the page's scripts run, replacing `requestAnimationFrame`, `performance.now`, `Date`, `setTimeout` and `setInterval`, and pausing CSS and Web Animations so it can set their time directly.
3. Loads the page, waits for fonts, runs the warmup, and starts your walkthrough script if there is one.
4. For every frame: moves the clock forward exactly one frame, runs everything that was due, takes a lossless PNG screenshot, and pipes it into ffmpeg.
5. ffmpeg scales and pads in the same pass and encodes once, so there's no second lossy step.

## License

[MIT](LICENSE)
