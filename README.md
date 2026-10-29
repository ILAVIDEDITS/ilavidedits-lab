# ILAVIDEDITS short-video lab

Scroll-driven 3D portfolio. You arrive at the lab door, ring in, and follow the process through eleven stops. All copy lives inside the 3D scene
(plaques with a number, a title and one line); a hidden text block carries the same content for screen readers and search.

Run: `python3 serve.py 5173`, open http://localhost:5173. Keys: arrows / PageUp / PageDown / Space (Shift+Space back), Home / End. `G` exports a .glb.

## The stops
0 door (bell, doors, smoke) · 1 before the line (deal, strategy, signature, scripts, you film) · 2 the production line (drop box, six numbered machines)
· 3 raw footage · 4 cutting · 5 sound · 6 colour · 7 captions · 8 export · 9 results (3M+ views, 100K+ likes) · 10 contact (big screen: the lab sends the video back; two real buttons).

## Edit
- `index.html` `LAB_CONFIG`: `email`, `orderUrl` (empty = prefilled order mail), `stats` (up to 3 numbers on the results wall), `clips`.
- Real clips: drop `1.mp4` ... `6.mp4` (vertical) into `clips/`; they replace the drawn placeholders automatically.
- `main.js`: `STOPS` (camera path, `via` = waypoints), `LABELS` (plaque text), stage blocks per stop. Stage k's updates run while stop `stopOf(k)` is near.

## Quality
`?quality=low` (also automatic on phones) turns off the heavier extras; frame rate below ~36 fps drops pixel ratio, then reflections and haze.
Debug: `?stop=N&t=SECONDS` freezes the camera at stop N.

## Export
`ilavidedits-lab.glb` is written by pressing G with the server running (named stage groups). Custom shader materials fall back to default ones.
