// Experts tab: live view of the adaptive expert cache's own rank table (served by
// GET /api/expert-heat, see serve/server.py's _expert_heat_get()). Polls only while
// the tab is visible (app.js calls ExpertsTab.start()/stop() from showTab()).
//
// Two view modes:
//  - "now": historical rank + current VRAM residency, as before.
//  - "stability": how often each (layer, expert) has been resident since the
//    window started (client-side accumulation across polls). Watching "now"
//    alone makes the whole non-core area look like uniform noise; this mode
//    shows that the churn is actually a small pool of cells trading places at
//    the residency cutoff, not a random reshuffle across all 24576 experts.
(() => {
  let timer = null;
  let built = null; // {n_layers, n_expert, half} the grids were last built for
  let mode = "now"; // "now" | "stability"
  let lastData = null;
  let residentCounts = null; // Int32Array(n_layers*n_expert): # of polls each cell was resident
  let pollCount = 0;

  function buildGrids(nLayers, nExpert) {
    const half = Math.ceil(nExpert / 2);
    for (const id of ["experts-grid-top", "experts-grid-bottom"]) {
      const el = $(id);
      el.style.gridTemplateColumns = `repeat(${half}, 1fr)`;
      el.innerHTML = "";
      for (let i = 0; i < nLayers * half; i++) {
        const c = document.createElement("div");
        c.className = "experts-cell";
        el.appendChild(c);
      }
    }
    built = { n_layers: nLayers, n_expert: nExpert, half };
    resetStability();
  }

  function resetStability() {
    residentCounts = built ? new Int32Array(built.n_layers * built.n_expert) : null;
    pollCount = 0;
  }

  function isDarkTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function colorCellNow(cell, rank, layer, expert, nResident, maxRank, dark) {
    if (rank < 0) {
      // never used: the app's own neutral surface token, so it reads correctly in either theme
      // instead of a fixed dark tile sitting on a light page
      cell.style.background = "var(--st-surface-2)";
      cell.style.outline = "none";
      cell.dataset.tip = `layer ${layer}, expert ${expert} — never used`;
      return;
    }
    if (nResident > 0 && rank < nResident) {
      const t = 1 - rank / nResident;
      const light = dark ? 55 + t * 35 : 45 + t * 15; // light theme: a touch darker to stay readable on white
      cell.style.background = `hsl(30 90% ${light}%)`;
      cell.style.outline = "1px solid #2dd4bf";
      cell.dataset.tip = `layer ${layer}, expert ${expert}, rank ${rank} — resident in VRAM now`;
    } else {
      const denom = Math.max(1, maxRank - nResident);
      const normalized = Math.min(1, Math.max(0, (rank - nResident) / denom));
      const heat = Math.pow(1 - normalized, 5);
      // dark theme: cold = near-black, hot = bright, cells pop off a dark canvas.
      // light theme: inverted - cold = pale tint, hot = a saturated, darker orange that reads on white.
      const light = dark ? 8 + heat * 28 : 92 - heat * 47;
      const sat = dark ? 25 + heat * 55 : 20 + heat * 60;
      cell.style.background = `hsl(25 ${sat}% ${light}%)`;
      cell.style.outline = "none";
      cell.dataset.tip = `layer ${layer}, expert ${expert}, rank ${rank}`;
    }
  }

  function colorCellStability(cell, count, polls, layer, expert, dark) {
    const t = polls > 0 ? count / polls : 0;
    const light = dark ? 8 + t * 44 : 95 - t * 55;
    const sat = dark ? 20 + t * 60 : 15 + t * 65;
    cell.style.background = t > 0 ? `hsl(172 ${sat}% ${light}%)` : "var(--st-surface-2)";
    cell.style.outline = t >= 0.97 ? "1px solid #2dd4bf" : "none";
    const pct = Math.round(t * 100);
    cell.dataset.tip = `layer ${layer}, expert ${expert} — resident in ${count}/${polls} polls (${pct}%)`;
  }

  // custom tooltip: a native `title` attribute renders with fixed OS colors that ignore the
  // page's own theme, so cell hover state is tracked here instead and shown in a themed div.
  let tipEl = null;
  function positionTip(e) {
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const r = tipEl.getBoundingClientRect();
    if (x + r.width > innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > innerHeight) y = e.clientY - r.height - pad;
    tipEl.style.left = `${Math.max(0, x)}px`;
    tipEl.style.top = `${Math.max(0, y)}px`;
  }
  function onGridPointerMove(e) {
    const cell = e.target.closest(".experts-cell");
    if (!cell || !cell.dataset.tip) {
      tipEl.hidden = true;
      return;
    }
    tipEl.textContent = cell.dataset.tip;
    tipEl.hidden = false;
    positionTip(e);
  }
  function onGridPointerLeave() {
    tipEl.hidden = true;
  }

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    for (const btn of $("experts-mode").children) {
      btn.setAttribute("aria-checked", btn.dataset.v === mode ? "true" : "false");
    }
    $("experts-legend-now").hidden = mode !== "now";
    $("experts-legend-stability").hidden = mode !== "stability";
    $("experts-reset").hidden = mode !== "stability";
    $("experts-mode-help").textContent = mode === "now"
      ? "Rows = layers, split into two halves side by side (first half of experts on top, second half below), columns = experts. A bright outline = the expert is physically resident in VRAM right now; the fill color is how highly ranked it is in the adaptive tier's own history otherwise."
      : "Same grid, different signal: how often each cell has been resident in VRAM since the window started (reset below), not just right now. A persistently bright cell is part of the stable core; a cell that only sometimes lights up is part of the small pool trading places at the residency cutoff — that's the 'dancing periphery'.";
    if (lastData) render(lastData);
  }

  function initControls() {
    $("experts-mode").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-v]");
      if (btn) setMode(btn.dataset.v);
    });
    $("experts-reset").addEventListener("click", () => {
      resetStability();
      if (lastData) render(lastData);
    });
  }

  function initTooltip() {
    if (tipEl) return;
    tipEl = $("experts-tooltip");
    for (const id of ["experts-grid-top", "experts-grid-bottom"]) {
      const el = $(id);
      el.addEventListener("pointermove", onGridPointerMove);
      el.addEventListener("pointerleave", onGridPointerLeave);
    }
    initControls();
  }

  function render(d) {
    const half = built.half;
    const maxRank = d.n_ranked > 0 ? d.n_ranked : 1;
    const nResident = d.n_resident || 0;
    const dark = isDarkTheme();
    const topCells = $("experts-grid-top").children;
    const bottomCells = $("experts-grid-bottom").children;
    for (let layer = 0; layer < d.n_layers; layer++) {
      for (let col = 0; col < half; col++) {
        const rowIdx = layer * half + col;
        for (const [cells, expert] of [[topCells, col], [bottomCells, col + half]]) {
          if (expert >= d.n_expert) continue;
          const idx = layer * d.n_expert + expert;
          if (mode === "now") {
            colorCellNow(cells[rowIdx], d.table[idx], layer, expert, nResident, maxRank, dark);
          } else {
            colorCellStability(cells[rowIdx], residentCounts[idx], pollCount, layer, expert, dark);
          }
        }
      }
    }
    const residentTxt = nResident > 0 ? `${nResident} resident now` : "resident count not available yet";
    const windowTxt = mode === "stability" ? ` · ${pollCount} polls in window` : "";
    $("experts-stat").textContent = `${d.n_layers} layers × ${d.n_expert} experts · ${residentTxt}${windowTxt}`;
  }

  async function tick() {
    let d;
    try {
      const r = await fetch("api/expert-heat", { headers: headers(), cache: "no-store" });
      d = await r.json();
    } catch (e) {
      return; // transient network hiccup: try again next tick
    }
    if (!d.enabled) {
      $("experts-off").hidden = false;
      $("experts-card").hidden = true;
      $("experts-off-text").textContent = d.reason || "The Experts tab needs \"expert_profile_save\" in the run config.";
      return;
    }
    $("experts-off").hidden = true;
    $("experts-card").hidden = false;
    if (!d.ready) {
      $("experts-stat").textContent = d.reason || "waiting for the first snapshot…";
      return;
    }
    if (!built || built.n_layers !== d.n_layers || built.n_expert !== d.n_expert) {
      buildGrids(d.n_layers, d.n_expert);
    }
    const nResident = d.n_resident || 0;
    for (let i = 0; i < d.n_layers * d.n_expert; i++) {
      if (d.table[i] >= 0 && d.table[i] < nResident) residentCounts[i]++;
    }
    pollCount++;
    lastData = d;
    render(d);
  }

  function start() {
    initTooltip();
    if (timer) return;
    tick();
    timer = setInterval(tick, 1500);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (tipEl) tipEl.hidden = true;
  }

  window.ExpertsTab = { start, stop };
})();
