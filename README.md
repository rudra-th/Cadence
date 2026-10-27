# Cadence

**Plan the day. Run the day.**

Cadence is an offline-first day planner. Paint the day into blocks on a 24-hour grid, then let the clock tell you what is next — one thing at a time. No account, no tracking, and nothing leaves the device.

**Live:** [cadenceapp.surge.sh](https://cadenceapp.surge.sh/)

## What it does

- **Plan:** a full 24-hour grid. Drag out blocks, name them, stretch or move them, and import an existing timetable PDF.
- **Run:** the clock shows one block, one countdown and the next block waiting. A separate stopwatch/timer handles focus sessions.
- **Review:** export the day as JSON or PDF, print an A4 sheet, or keep the grid as a record of what actually happened.
- **Stay offline:** a service worker caches the app; all plans live in `localStorage`.
- **Stay private:** no sign-in, no server, no analytics, and no notifications unless you ask.

## Run locally

Cadence is a static site with no build step. From this folder:

```sh
python serve.py
```

The default port is `4173`. Any static server also works:

```sh
python -m http.server 8000
```

Then open `http://localhost:8000`.

## Structure

- `index.html` — landing page and the "day in four acts" film.
- `plan.html` — the 24-hour planner and timetable import.
- `clock.html` — the focus clock, timer and stopwatch.
- `assets/js/` — store, planner, clock, import/export, theme and service-worker registration.
- `assets/vendor/` — vendored jsPDF and html2canvas for PDF export.
- `sw.js` / `manifest.webmanifest` — offline and PWA support.

Plans and settings are stored under the `cadence.store.v1` key in `localStorage`. Export JSON before clearing browser data if you want a backup.

## Deploy

Publish the project folder as static files. The included `CNAME` points at `cadenceapp.surge.sh` for Surge; remove or change it for another host. No server-side code is required.

## Privacy

Plans, timers and settings stay on the device. There is no cloud sync and no analytics.
