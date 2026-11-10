// Experts tab: live view of the adaptive expert cache's own rank table (served by
// GET /api/expert-heat, see serve/server.py's _expert_heat_get()). Polls only while
// the tab is visible (app.js calls ExpertsTab.start()/stop() from showTab()).
(() => {
  let timer = null;
  let built = null; // {n_layers, n_expert} the grids were last built for

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
  }

  function isDarkTheme() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function colorCell(cell, rank, layer, expert, nResident, maxRank, dark) {
    if (rank < 0) {
      // never used: the app's own neutral surface token, so it reads correctly in either theme
      // instead of a fixed dark tile sitting on a light page
      cell.style.background = "var(--st-surface-2)";
      cell.style.outline = "none";
      cell.title = `layer ${layer}, expert ${expert} — never used`;
      return;
    }
    if (nResident > 0 && rank < nResident) {
      const t = 1 - rank / nResident;
      const light = dark ? 55 + t * 35 : 45 + t * 15; // light theme: a touch darker to stay readable on white
      cell.style.background = `hsl(30 90% ${light}%)`;
      cell.style.outline = "1px solid #2dd4bf";
      cell.title = `layer ${layer}, expert ${expert}, rank ${rank} — resident in VRAM now`;
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
      cell.title = `layer ${layer}, expert ${expert}, rank ${rank}`;
    }
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
    const half = built.half;
    const maxRank = d.n_ranked > 0 ? d.n_ranked : 1;
    const nResident = d.n_resident || 0;
    const dark = isDarkTheme();
    const topCells = $("experts-grid-top").children;
    const bottomCells = $("experts-grid-bottom").children;
    for (let layer = 0; layer < d.n_layers; layer++) {
      for (let col = 0; col < half; col++) {
        const rowIdx = layer * half + col;
        const expertTop = col;
        const expertBottom = col + half;
        if (expertTop < d.n_expert) {
          colorCell(topCells[rowIdx], d.table[layer * d.n_expert + expertTop], layer, expertTop, nResident, maxRank, dark);
        }
        if (expertBottom < d.n_expert) {
          colorCell(bottomCells[rowIdx], d.table[layer * d.n_expert + expertBottom], layer, expertBottom, nResident, maxRank, dark);
        }
      }
    }
    const residentTxt = nResident > 0 ? `${nResident} resident now` : "resident count not available yet";
    $("experts-stat").textContent = `${d.n_layers} layers × ${d.n_expert} experts · ${residentTxt}`;
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, 1500);
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  window.ExpertsTab = { start, stop };
})();
