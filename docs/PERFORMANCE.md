# Performance measurement

Run `npm run benchmark` on macOS to create disposable 50-, 10,000- and 100,000-commit histories under ignored `work/performance/`. The script measures bounded Git reads, graph layout and formatting for a visible row window.

These are development measurements, not terminal frame times. They depend on hardware, Git version, filesystem caches and other activity. Native terminal paint, full-host memory attribution and long-session behaviour require separate measurement.

The browser uses 200-commit pages with a 5,000-loaded-commit cap, bounded file/patch reads, a visible history window and a bounded immutable-detail cache. It polls only while open and does not intentionally fetch network objects during browsing. The tests exercise these bounds; they do not establish a universal latency or memory guarantee.
