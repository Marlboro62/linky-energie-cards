/*
 * Cartes Linky Énergie — cinq cartes indépendantes dans un seul fichier, pour Home Assistant,
 * au style des cartes MyElectricalData new (Carte Enedis Linky New) :
 *
 *   custom:linky-puissance-card     puissance en direct sur la puissance souscrite
 *   custom:linky-facture-card       coût du cycle de facturation et projection
 *   custom:linky-tempo-postes-card  énergie et coût des 6 postes Tempo
 *   custom:linky-tempo-prix-card    prix Tempo et vérification de leur source
 *   custom:linky-cycle-card         contrôle des compteurs du cycle et scripts de maintenance
 *   custom:linky-enedis-status-card état des services Enedis DataHub (Data Connect)
 *
 * Une seule ressource à ajouter ; chaque carte s'utilise seule. Aucune ne remplace une autre carte.
 */

(() => {
const CARD_VERSION = "0.3.0-beta.7";

/* ------------------------------------------------------------- utilitaires */

const fmt = (n, digits = 1) =>
  n === null || n === undefined
    ? "—"
    : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const TEMPO = {
  blue: { label: "Bleu", cls: "t-blue" },
  white: { label: "Blanc", cls: "t-white" },
  red: { label: "Rouge", cls: "t-red" },
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Classe de thème de la carte :
 *  v2   : style MyElectricalData, toujours bleu nuit ;
 *  auto : style MyElectricalData, bleu nuit si Home Assistant est en mode sombre, clair sinon ;
 *  ha   : couleurs du thème Home Assistant (clair ou sombre). */
const themeClass = (theme, hass) => {
  const light = hass?.themes?.darkMode === false;
  if (theme === "ha") return `th-ha${light ? " light" : ""}`;
  if (theme === "auto") return `th-v2${light ? " light" : ""}`;
  return "th-v2";
};

/* ------------------------------------------------------------ base commune */

/** Postes Tempo : clé dans les noms d'entités, couleur, libellés. */
const POSTES = [
  { k: "bleu_hc", c: "blue", en: "blue_hc", h: "HC" },
  { k: "bleu_hp", c: "blue", en: "blue_hp", h: "HP" },
  { k: "blanc_hc", c: "white", en: "white_hc", h: "HC" },
  { k: "blanc_hp", c: "white", en: "white_hp", h: "HP" },
  { k: "rouge_hc", c: "red", en: "red_hc", h: "HC" },
  { k: "rouge_hp", c: "red", en: "red_hp", h: "HP" },
];

/** Poste en cours d'après un texte du type « HP BLEU » (Lixee) ou « bleu_hp ». */
const currentPoste = (txt) => {
  const t = String(txt || "").toUpperCase();
  const c = /ROUGE|RED/.test(t) ? "rouge" : /BLANC|WHITE/.test(t) ? "blanc" : /BLEU|BLUE/.test(t) ? "bleu" : null;
  const h = /HC/.test(t) ? "hc" : /HP/.test(t) ? "hp" : null;
  return c && h ? `${c}_${h}` : null;
};

/** Poste HC ou HP en cours d'après un texte du type « HC.. », « Heures creuses » (Lixee, Linky TIC, PTEC). */
const currentHcHp = (txt) => {
  const t = String(txt || "").toUpperCase();
  return /\bHC|CREUSE/.test(t) ? "hc" : /\bHP|PLEINE/.test(t) ? "hp" : null;
};

const posteLabel = (p) => `${TEMPO[p.c].label} ${p.h}`;
const kwhFmt = (v) => (v === null || v === undefined ? "—" : fmt(v, Math.abs(v) < 10 ? 2 : 1));
const priceFmt = (v) => (v === null || v === undefined ? "—" : `${fmt(v, 4)} €`);

/** Montant en euros, 3 décimales sous 10 centimes. */
const eur = (n) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const d = Math.abs(n) < 0.1 && n !== 0 ? 3 : 2;
  return n.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }) + " €";
};

/** « il y a 3 h », « il y a 2 j ». */
const ago = (iso) => {
  if (!iso) return "jamais";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 90) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
};

const BRAND = `<svg viewBox="0 0 32 32" aria-hidden="true"><path class="house" d="M4 14.5 16 4l12 10.5V27a1.5 1.5 0 0 1-1.5 1.5h-5M10.5 28.5h-5A1.5 1.5 0 0 1 4 27V14.5"/><path class="bolt" d="M17.5 9 11 18h4.5l-1.5 8 7-10h-4.6z"/></svg>`;

/** Base des cartes : configuration, lecture des états, clics, rendu seulement quand une entité suivie change. */
class EnergyBase extends HTMLElement {
  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = { ...this.constructor.DEFAULTS, ...(config || {}) };
    this._sig = null;
    this._armed = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._clicks) {
      this.shadowRoot.addEventListener("click", (this._clicks = (ev) => this._click(ev)));
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  getCardSize() {
    return 5;
  }

  _click(ev) {
    const tab = ev.target.closest?.("[data-tab]");
    if (tab) {
      this._tab = tab.dataset.tab;
      this._render(true);
      return;
    }
    const run = ev.target.closest?.("[data-run]");
    if (run) {
      ev.stopPropagation();
      const id = run.dataset.run;
      // Premier clic : arme le bouton ; second clic dans les 5 s : lance le script.
      if (this._armed === id) {
        this._armed = null;
        clearTimeout(this._armTimer);
        const [domain] = id.split(".");
        this._hass?.callService(domain, "turn_on", { entity_id: id });
      } else {
        this._armed = id;
        clearTimeout(this._armTimer);
        this._armTimer = setTimeout(() => { this._armed = null; this._render(true); }, 5000);
      }
      this._render(true);
      return;
    }
    const el = ev.target.closest?.("[data-entity]");
    if (el && el.dataset.entity) {
      const e = new Event("hass-more-info", { bubbles: true, composed: true });
      e.detail = { entityId: el.dataset.entity };
      this.dispatchEvent(e);
    }
  }

  _st(id) {
    return id ? this._hass?.states?.[id] : undefined;
  }

  _num(id) {
    const st = this._st(id);
    if (!st || st.state === "" || st.state === "unknown" || st.state === "unavailable") return null;
    const n = Number(st.state);
    return Number.isFinite(n) ? n : null;
  }

  _unit(id, d = "") {
    return this._st(id)?.attributes?.unit_of_measurement ?? d;
  }

  _name(id, d) {
    return this._st(id)?.attributes?.friendly_name || d || id;
  }

  /** Entités dont un changement redessine la carte. */
  _watch() {
    return [];
  }

  _render(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const c = this._config;
    const ids = [...this._watch(), c.tarif ? this._tarif(c.tarif) : null];
    const sig = `${c.theme}|${this._hass.themes?.darkMode}|${this._tab}|${this._armed}|${this._extraSig?.() ?? ""}|` +
      ids.map((id) => { const s = this._st(id); return s ? `${s.state}@${s.last_changed}` : "-"; }).join("|");
    if (!force && sig === this._sig) return;
    this._sig = sig;
    const { sub = "", right = "", body = "", cls = "" } = this._content();
    this.shadowRoot.innerHTML = `${STYLE}${EN_STYLE}<ha-card class="${themeClass(c.theme, this._hass)} ${cls}">
      <header>
        <div class="brand">${BRAND}<div><div class="title">${esc(c.title)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div></div>
        ${right ? `<div class="tempo">${right}</div>` : ""}
      </header>${body}</ha-card>`;
  }

  /** Capteur de la période tarifaire : celui de la configuration, sinon un capteur PTEC / période tarifaire trouvé seul. */
  _tarif(id) {
    if (id && this._st(id)) return id;
    const ids = Object.keys(this._hass?.states || {});
    return ids.find((x) => /^sensor\..*(_ptec|_ltarf|periode_tarifaire(_en_cours)?|tarif_en_cours|current_tarif|current_price)$/.test(x)) || id;
  }

  /** Pastille « poste en cours » : poste Tempo (« HP BLEU »), sinon HC ou HP (PTEC « HC.. »). */
  _postePill(tarifId) {
    tarifId = this._tarif(tarifId);
    const p = currentPoste(this._st(tarifId)?.state);
    if (!p) {
      const hp = currentHcHp(this._st(tarifId)?.state);
      return hp ? `<div class="pill" data-entity="${esc(tarifId)}"><span class="dot ${hp === "hc" ? "d-hc" : "d-hp"}"></span><span class="pill-l">En cours</span><span class="pill-v">${hp.toUpperCase()}</span></div>` : "";
    }
    const P = POSTES.find((x) => x.k === p);
    return `<div class="pill ${TEMPO[P.c].cls}" data-entity="${esc(tarifId)}"><span class="dot"></span><span class="pill-l">En cours</span><span class="pill-v">${P.h} ${TEMPO[P.c].label}</span></div>`;
  }

  _tabs(list) {
    return `<div class="en-tabs">${list.map((t) => `<button data-tab="${t.key}" class="${t.key === this._tab ? "on" : ""}">${t.label}</button>`).join("")}</div>`;
  }
}

/* ------------------------------------------------------- 1. puissance en direct */

class LinkyPuissanceCard extends EnergyBase {
  static DEFAULTS = {
    title: "Puissance",
    power: "sensor.lixee_sinsts",
    power_active: "", // puissance active en W (facturée), si le compteur la donne : coût réel et cos φ
    subscribed: "sensor.lixee_pref",
    subscribed_kva: "", // puissance souscrite saisie (kVA), si aucun capteur ne la donne
    contract: "tempo", // tempo, hchp ou base : choisit le prix du kWh en cours
    tarif: "sensor.lixee_current_price",
    price: "sensor.tempo_tarif_ttc_actuel",
    price_hc: "", // HC/HP : prix TTC du kWh (nombre ou entité)
    price_hp: "",
    price_base: "", // Base : prix TTC du kWh (nombre ou entité)
    cost_rate: "sensor.tempo_total_instantane",
    overrun: "binary_sensor.linky_depassement_puissance",
    overruns_day: "sensor.linky_depassements_jour",
    show_peak: true,
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-puissance-card-editor");
  }

  _watch() {
    const c = this._config;
    return [c.power, c.power_active, c.subscribed, c.tarif, c.price, c.cost_rate, c.overrun, c.overruns_day, c.price_hc, c.price_hp, c.price_base]
      .filter((x) => typeof x === "string" && x.includes("."));
  }

  /** Prix du kWh en cours : celui du poste HC ou HP (PTEC), ou de la Base, sinon le capteur « price ». */
  _currentPrice() {
    const c = this._config;
    const key = c.contract === "hchp" ? currentHcHp(this._st(this._tarif(c.tarif))?.state) : c.contract === "base" ? "base" : null;
    const opt = key ? c[`price_${key}`] : null;
    const v = priceOpt(this, opt);
    if (v !== null) return { v, id: typeof opt === "string" && opt.includes(".") ? opt : "" };
    return { v: this._num(c.price), id: c.price };
  }

  _extraSig() {
    return this._peak?.v ?? "";
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._loadPeak(), 5 * 60 * 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  set hass(hass) {
    const first = !this._hass;
    super.hass = hass;
    if (first) this._loadPeak();
  }

  /** Pic du jour : statistique « max » de Home Assistant sur la puissance (si le capteur en a). */
  async _loadPeak() {
    const c = this._config;
    if (!c?.show_peak || !this._hass?.callWS || !c.power) return;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: start.toISOString(),
        statistic_ids: [c.power],
        period: "hour",
        types: ["max"],
      });
      const rows = res?.[c.power] || [];
      let best = null;
      for (const r of rows) if (Number.isFinite(r.max) && (!best || r.max > best.v)) best = { v: r.max, t: r.start };
      this._peak = best;
      this._render();
    } catch (e) {
      this._peak = null;
    }
  }

  _content() {
    const c = this._config;
    const va = this._num(c.power);
    const unit = this._unit(c.power, "VA");
    // puissance active (W) : capteur dédié, ou « power » lui-même s'il est en W. kW ramenés en W.
    const toW = (id) => { const n = this._num(id); if (n === null) return null; return /^kw$/i.test(this._unit(id)) ? n * 1000 : n; };
    const powerIsW = /^k?w$/i.test(unit);
    const watts = c.power_active ? toW(c.power_active) : powerIsW ? toW(c.power) : null;
    const cosPhi = c.power_active && va !== null && watts !== null && va > 0 && !powerIsW ? watts / va : null;
    // Puissance souscrite : saisie en kVA, sinon capteur en kVA (Lixee, PREF), en VA, ou en ampères (ISOUSC du mode historique : 45 A = 9 kVA)
    const typed = Number(String(c.subscribed_kva ?? "").replace(",", "."));
    const sub = this._num(c.subscribed);
    const subUnit = String(this._unit(c.subscribed, "kVA")).toLowerCase();
    const isAmp = subUnit === "a" || /isousc/i.test(c.subscribed || "");
    const subVA = Number.isFinite(typed) && typed > 0 ? typed * 1000
      : sub === null ? null : isAmp ? sub * 200 : subUnit.startsWith("k") || sub < 100 ? sub * 1000 : sub;
    const pct = va !== null && subVA ? (va / subVA) * 100 : null;
    const lvl = pct === null ? "" : pct >= 90 ? "b-alert" : pct >= 70 ? "b-warn" : "b-ok";
    const over = this._st(c.overrun)?.state === "on";
    const nOver = this._num(c.overruns_day);
    const { v: price, id: priceId } = this._currentPrice();
    const rate = this._num(c.cost_rate);
    const rateUnit = this._unit(c.cost_rate, "€/h");
    // coût estimé : puissance active si on l'a (réelle), sinon puissance apparente (VA, surestime le coût)
    const estBase = watts ?? va;
    const estRate = estBase !== null && price !== null ? (estBase / 1000) * price : null;

    const peak = this._peak;
    const peakPct = peak && subVA ? (peak.v / subVA) * 100 : null;
    const body = `
      ${over ? `<div class="en-alert"><ha-icon icon="mdi:flash-alert"></ha-icon><div><b>Dépassement de la puissance souscrite en cours.</b> Le disjoncteur peut couper : délestez un appareil.</div></div>` : ""}
      <div class="en-hero" data-entity="${esc(c.power)}">
        <div class="en-hero-l">Puissance appelée</div>
        <div class="en-hero-v">${va !== null ? fmt(va, 0) : "—"}<span>${esc(unit)}</span></div>
        ${pct !== null ? `<div class="g-bar ${lvl}"><i style="width:${Math.min(100, pct)}%"></i>${[50, 70, 90].map((m) => `<b class="tick" style="left:${m}%"></b>`).join("")}${peakPct !== null ? `<b class="peak" style="left:${Math.min(100, peakPct)}%" title="Pic du jour"></b>` : ""}</div>
        <div class="g-n"><span class="g-k"><b>${powerIsW ? "≈ " : ""}${fmt(pct, 0)} %</b> de la puissance souscrite${powerIsW ? " (W comparés aux kVA)" : ""}</span><span>${fmt(subVA / 1000, subVA % 1000 ? 1 : 0)} kVA</span></div>` : ""}
      </div>
      <div class="tiles en-tiles">
        ${rate !== null || estRate !== null ? `<div class="tile" data-entity="${esc(rate !== null ? c.cost_rate : priceId)}"><div class="tile-l">Coût en ce moment</div><div class="tile-v">${eur(rate ?? estRate)}<span>${esc(rate !== null ? String(rateUnit).replace("€", "").trim() : "/h")}</span></div><div class="tile-n">${rate === null ? (watts !== null ? "puissance active × prix du kWh" : "estimé en VA : ajoutez un capteur en W pour le coût réel") : `≈ ${eur((rate ?? 0) * 24)} sur 24 h à ce rythme`}</div></div>` : ""}
        ${watts !== null && !powerIsW ? `<div class="tile" data-entity="${esc(c.power_active)}"><div class="tile-l">Puissance active</div><div class="tile-v">${fmt(watts, 0)}<span>W</span></div><div class="tile-n">${cosPhi !== null ? `cos φ ${fmt(cosPhi, 2)} · ce qui est facturé` : "ce qui est facturé"}</div></div>` : ""}
        ${peak ? `<div class="tile" data-entity="${esc(c.power)}"><div class="tile-l">Pic du jour</div><div class="tile-v">${fmt(peak.v, 0)}<span>${esc(unit)}</span></div><div class="tile-n">à ${new Date(peak.t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}${peakPct !== null ? ` · ${fmt(peakPct, 0)} %` : ""}</div></div>` : ""}
        ${nOver !== null ? `<div class="tile ${nOver > 0 ? "t-warn" : ""}" data-entity="${esc(c.overruns_day)}"><div class="tile-l">Dépassements aujourd'hui</div><div class="tile-v">${fmt(nOver, 0)}</div><div class="tile-n">${nOver > 0 ? "pensez à décaler les gros appareils" : "aucun"}</div></div>` : ""}
      </div>`;
    const right = this._postePill(c.tarif) + (price !== null ? `<div class="pill" data-entity="${esc(priceId)}"><span class="pill-l">kWh</span><span class="pill-v">${priceFmt(price)}</span></div>` : "");
    return { sub: "En direct, compteur Linky", right, body, cls: over ? "en-over" : "" };
  }
}

/* ------------------------------------------------------- 2. facture du cycle */

class LinkyFactureCard extends EnergyBase {
  static DEFAULTS = {
    title: "Facture",
    cycle_start: "10-01",
    cost_cycle: "sensor.tempo_cout_total_cycle_en_cours",
    energy_cycle: "sensor.tempo_cout_energie_cycle_en_cours",
    cost_month: "sensor.tempo_cout_total_ce_mois",
    energy_month: "sensor.tempo_cout_energie_ce_mois",
    cost_day: "sensor.tempo_cout_total_aujourd_hui",
    estimate_month: "sensor.edf_estimation_mensuelle",
    subscription_month: "input_number.abonnement_mensuel_tempo",
    kwh_cycle: "sensor.conso_totale_cycle_en_cours",
    kwh_prev_cycle: "sensor.conso_cycle_precedent_archive",
    kwh_month: "sensor.conso_totale_mensuelle",
    kwh_day: "sensor.tempo_consommation_totale_aujourd_hui",
    budget_month: null,
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-facture-card-editor");
  }

  _watch() {
    const c = this._config;
    return [c.cost_cycle, c.energy_cycle, c.cost_month, c.energy_month, c.cost_day, c.estimate_month, c.subscription_month, c.kwh_cycle, c.kwh_prev_cycle, c.kwh_month, c.kwh_day];
  }

  _extraSig() {
    return new Date().toDateString();
  }

  /** Début et fin du cycle de facturation en cours (cycle_start au format MM-JJ). */
  _cycle() {
    const [mm, dd] = String(this._config.cycle_start || "10-01").split("-").map(Number);
    const now = new Date();
    let start = new Date(now.getFullYear(), (mm || 10) - 1, dd || 1);
    if (start > now) start = new Date(now.getFullYear() - 1, (mm || 10) - 1, dd || 1);
    const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
    const total = Math.round((end - start) / 86400000);
    const elapsed = Math.max(1, (now - start) / 86400000);
    return { start, end, total, elapsed };
  }

  _content() {
    const c = this._config;
    const cy = this._cycle();
    const total = this._num(c.cost_cycle);
    const energy = this._num(c.energy_cycle);
    const subsc = total !== null && energy !== null ? total - energy : null;
    const proj = total !== null ? (total / cy.elapsed) * cy.total : null;
    const kwh = this._num(c.kwh_cycle);
    const prevKwh = this._num(c.kwh_prev_cycle);
    const projKwh = kwh !== null ? (kwh / cy.elapsed) * cy.total : null;
    const avg = energy !== null && kwh ? energy / kwh : null;
    const evo = projKwh !== null && prevKwh ? ((projKwh - prevKwh) / prevKwh) * 100 : null;
    const pctYear = Math.min(100, (cy.elapsed / cy.total) * 100);
    const startTxt = cy.start.getDate() === 1 ? `1er ${cy.start.toLocaleDateString("fr-FR", { month: "long" })}` : cy.start.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
    const endTxt = new Date(cy.end - 86400000).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

    const month = this._num(c.cost_month);
    const est = this._num(c.estimate_month);
    const budget = Number(c.budget_month) || null;
    const day = this._num(c.cost_day);
    const tile = (id, label, v, note, cls = "") =>
      v === null ? "" : `<div class="tile ${cls}" data-entity="${esc(id)}"><div class="tile-l">${label}</div><div class="tile-v">${v}</div>${note ? `<div class="tile-n">${note}</div>` : ""}</div>`;
    const monthName = new Date().toLocaleDateString("fr-FR", { month: "long" });

    const body = `
      <div class="en-hero" data-entity="${esc(c.cost_cycle)}">
        <div class="en-hero-l">Cycle en cours, depuis le ${startTxt}</div>
        <div class="en-hero-row">
          <div class="en-hero-v">${total !== null ? eur(total).replace(" €", "") : "—"}<span>€</span></div>
          ${proj !== null ? `<div class="en-proj" title="Coût du cycle ramené à 365 jours au rythme actuel : l'hiver et les jours rouges ne sont pas anticipés."><span>Projection au rythme actuel</span><b>${fmt(proj, 0)} €</b></div>` : ""}
        </div>
        ${energy !== null ? `<div class="en-hero-n">dont énergie <b>${eur(energy)}</b>${subsc !== null ? ` · abonnement <b>${eur(subsc)}</b>` : ""}${avg !== null ? ` · <b>${fmt(avg, 4)} €</b> le kWh en moyenne` : ""}</div>` : ""}
        <div class="g-bar b-ok cyc"><i style="width:${pctYear}%"></i></div>
        <div class="g-n"><span>jour ${Math.floor(cy.elapsed) + 1} sur ${cy.total}</span><span>fin le ${endTxt}</span></div>
      </div>
      <div class="tiles en-tiles">
        ${tile(c.cost_month, `${cap(monthName)}`, month !== null ? eur(month) : null, [this._num(c.energy_month) !== null ? `énergie ${eur(this._num(c.energy_month))}` : null, this._num(c.kwh_month) !== null ? `${kwhFmt(this._num(c.kwh_month))} kWh` : null].filter(Boolean).join(" · "))}
        ${tile(c.estimate_month, "Estimation du mois", est !== null ? eur(est) : null, budget ? `budget ${eur(budget)}${est !== null ? (est > budget ? ` · <em class="warn">+${eur(est - budget)}</em>` : ` · <em class="ok">${eur(budget - est)} de marge</em>`) : ""}` : "", budget && est > budget ? "t-warn" : "")}
        ${tile(c.cost_day, "Aujourd'hui", day !== null ? eur(day) : null, this._num(c.kwh_day) !== null ? `${kwhFmt(this._num(c.kwh_day))} kWh` : "")}
        ${tile(c.kwh_cycle, "Énergie du cycle", kwh !== null ? `${fmt(kwh, 0)}<span>kWh</span>` : null, prevKwh !== null ? `projection ${fmt(projKwh, 0)} kWh · cycle précédent ${fmt(prevKwh, 0)} kWh${evo !== null ? ` <em class="${evo > 0 ? "warn" : "ok"}">${evo > 0 ? "+" : ""}${fmt(evo, 0)} %</em>` : ""}` : "")}
      </div>`;
    const right = this._num(c.subscription_month) !== null
      ? `<div class="pill" data-entity="${esc(c.subscription_month)}"><span class="pill-l">Abonnement</span><span class="pill-v">${eur(this._num(c.subscription_month))}/mois</span></div>`
      : "";
    return { sub: "EDF Tempo, au tarif en vigueur", right, body };
  }
}

/* ------------------------------------------------------- 3. énergie par poste */

const PERIODS = [
  { key: "jour", label: "Aujourd'hui", cfg: "suffix_day" },
  { key: "mois", label: "Ce mois", cfg: "suffix_month" },
  { key: "cycle", label: "Cycle", cfg: "suffix_cycle" },
];

/** Contrats HC/HP et Base : postes, et périodes de l'export Home Assistant de MyElectricalData. */
const CONTRACTS = {
  hchp: [
    { k: "hc", h: "HC", label: "Heures creuses", cls: "s-hc" },
    { k: "hp", h: "HP", label: "Heures pleines", cls: "s-hp" },
  ],
  base: [{ k: "base", h: "Base", label: "Base", cls: "s-base" }],
};
const MED_PERIODS = [
  { key: "jour", label: "Aujourd'hui", med: null }, // pas dans l'export MyElectricalData : capteurs choisis seulement
  { key: "hier", label: "Hier", med: "yesterday" },
  { key: "semaine", label: "Semaine", med: "this_week" },
  { key: "mois", label: "Ce mois", med: "this_month" },
  { key: "annee", label: "Cette année", med: "this_year" },
];


/** Préfixe des capteurs de consommation de l'export MyElectricalData : sensor.myelectricaldata_linky_<pdl>_consumption_ */
const medPrefix = (hass) => {
  const id = Object.keys(hass?.states || {}).find((x) => /^sensor\.myelectricaldata_linky_\d{14}_consumption_this_(month|year)(_h[cp])?$/.test(x));
  return id ? id.replace(/this_(month|year)(_h[cp])?$/, "") : "";
};

/** Prix d'une option : nombre (€/kWh) ou entité. */
const priceOpt = (card, v) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^[a-z_]+\.[\w]+$/.test(s)) return card._num(s);
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

class LinkyTempoPostesCard extends EnergyBase {
  static DEFAULTS = {
    title: "",
    contract: "tempo", // tempo, hchp (heures creuses / heures pleines) ou base
    period: "mois",
    energy_prefix: "", // HC/HP et Base : préfixe des capteurs de consommation (vide = export MyElectricalData)
    price_hc: "", price_hp: "", price_base: "", // HC/HP et Base : prix du kWh (nombre ou entité)
    prefix: "sensor.tempo_",
    suffix_day: "_energie_aujourdhui",
    suffix_month: "_energie_ce_mois",
    suffix_cycle: "_energie_cette_annee",
    price_prefix: "sensor.tempo_prix_",
    source_prefix: "sensor.myelectricaldata_tempo_price_", // prix de MyElectricalData, si les prix utilisés n'existent pas
    tarif: "sensor.lixee_current_price",
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-tempo-postes-card-editor");
  }

  setConfig(config) {
    const contract = CONTRACTS[config?.contract] ? config.contract : "tempo";
    super.setConfig({ ...config, title: config?.title || (contract === "tempo" ? "Énergie par poste Tempo" : contract === "hchp" ? "Énergie HC / HP" : "Énergie") });
    const list = contract === "tempo" ? PERIODS : MED_PERIODS;
    if (!this._tab || !list.some((p) => p.key === this._tab)) {
      this._tab = list.some((p) => p.key === this._config.period) ? this._config.period : "mois";
      this._render(true);
    }
  }

  /** HC/HP et Base : identifiant du capteur de consommation d'un poste pour une période. */
  _simpleId(p, per) {
    const own = this._config[`energy_${p.k}_${per.key}`]; // capteur choisi dans l'éditeur (utility_meter, Lixee…)
    if (typeof own === "string" && own.includes(".")) return own;
    const pre = this._config.energy_prefix || medPrefix(this._hass);
    return pre && per.med ? `${pre}${per.med}${p.k === "base" ? "" : `_${p.k}`}` : null;
  }

  /** Onglets HC/HP et Base : seulement les périodes qui ont des données (toutes sauf Aujourd'hui s'il n'y en a aucune). */
  _simplePeriods() {
    const keys = this._config.contract === "base" ? ["base", "hc", "hp"] : CONTRACTS[this._config.contract].map((p) => p.k);
    const ok = MED_PERIODS.filter((per) => keys.some((k) => this._num(this._simpleId({ k }, per)) !== null));
    return ok.length ? ok : MED_PERIODS.filter((per) => per.med);
  }

  _watch() {
    const c = this._config;
    if (CONTRACTS[c.contract]) {
      const ids = CONTRACTS[c.contract].flatMap((p) => MED_PERIODS.map((x) => this._simpleId(p, x))).filter(Boolean);
      if (c.contract === "base") ids.push(...MED_PERIODS.flatMap((x) => ["hc", "hp"].map((k) => this._simpleId({ k }, x))).filter(Boolean));
      return [c.tarif, c.price_hc, c.price_hp, c.price_base, ...ids].filter((x) => typeof x === "string" && x.includes("."));
    }
    return [c.tarif, ...POSTES.flatMap((p) => [`${c.price_prefix}${p.k}`, `${c.source_prefix}${p.en}`, ...PERIODS.map((x) => `${c.prefix}${p.k}${c[x.cfg]}`)])];
  }

  /** Contrats HC/HP et Base : énergie par poste (export MyElectricalData) et coût au prix saisi. */
  _contentSimple() {
    const c = this._config;
    const periods = this._simplePeriods();
    const per = periods.find((p) => p.key === this._tab) || periods.find((p) => p.key === "mois") || periods[0];
    const postes = CONTRACTS[c.contract];
    this._tab = per.key;
    const tarif = this._tarif(c.tarif);
    const cur = c.contract === "hchp" ? currentHcHp(this._st(tarif)?.state) : null;
    const rows = postes.map((p) => {
      let id = this._simpleId(p, per);
      let kwh = this._num(id);
      // Base sans capteur dédié : somme des capteurs HC et HP de l'export
      if (kwh === null && p.k === "base") {
        const hc = this._num(this._simpleId({ k: "hc" }, per)), hp = this._num(this._simpleId({ k: "hp" }, per));
        if (hc !== null || hp !== null) { kwh = (hc || 0) + (hp || 0); id = this._simpleId({ k: "hp" }, per); }
      }
      const price = priceOpt(this, c[`price_${p.k}`]);
      return { p, id, kwh, price, cost: kwh !== null && price !== null ? kwh * price : null };
    });
    if (!rows.some((r) => r.kwh !== null)) {
      return { sub: per.label, body: `${this._tabs(periods)}<div class="empty">Consommation introuvable<span>Choisissez vos capteurs de consommation HC et HP dans l'éditeur (section « Mes capteurs de consommation »), ou activez l'export Home Assistant de MyElectricalData (<code>sensor.myelectricaldata_linky_&lt;pdl&gt;_consumption_this_month_hc</code>…).</span></div>` };
    }
    const sumK = rows.reduce((a, r) => a + (r.kwh || 0), 0);
    const sumE = rows.reduce((a, r) => a + (r.cost || 0), 0);
    const anyCost = rows.some((r) => r.cost !== null);
    const split = rows.length > 1 && sumK > 0
      ? `<div class="bar en-split">${rows.filter((r) => r.kwh > 0).map((r) => `<i class="${r.p.cls}" style="width:${(r.kwh / sumK) * 100}%" title="${r.p.label} : ${kwhFmt(r.kwh)} kWh"></i>`).join("")}</div>`
      : "";
    const table = `<table class="en-t">
        <thead><tr><th>Poste</th><th>kWh</th>${rows.length > 1 ? "<th>Part</th>" : ""}<th>Prix</th>${anyCost ? "<th>Coût</th>" : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.p.k === cur ? "cur" : ""}" data-entity="${esc(r.id || "")}">
          <td><i class="sq ${r.p.cls}"></i>${r.p.label}${r.p.k === cur ? '<span class="now">en cours</span>' : ""}</td>
          <td>${kwhFmt(r.kwh)}</td>
          ${rows.length > 1 ? `<td>${sumK > 0 && r.kwh !== null ? `${fmt((r.kwh / sumK) * 100, 0)} %` : "—"}</td>` : ""}
          <td>${r.price !== null ? fmt(r.price, 4) : "—"}</td>
          ${anyCost ? `<td>${eur(r.cost)}</td>` : ""}
        </tr>`).join("")}</tbody>
        ${rows.length > 1 ? `<tfoot><tr><td>Total</td><td>${kwhFmt(sumK)}</td><td></td><td>${sumK > 0 && anyCost ? fmt(sumE / sumK, 4) : ""}</td>${anyCost ? `<td>${eur(sumE)}</td>` : ""}</tr></tfoot>` : ""}
      </table>`;
    const pill = cur ? this._postePill(c.tarif) : "";
    const body = `${this._tabs(periods)}
      <div class="en-sum"><div><span>Énergie</span><b>${kwhFmt(sumK)} kWh</b></div>${anyCost ? `<div><span>Coût énergie</span><b>${eur(sumE)}</b></div>` : ""}</div>
      ${split}${table}
      <footer>${anyCost ? "Coût calculé avec le prix du kWh saisi, hors abonnement. " : "Saisissez le prix du kWh dans l'éditeur pour voir le coût. "}Données de MyElectricalData, arrêtées à la veille.</footer>`;
    return { sub: per.label, right: pill, body };
  }

  _content() {
    const c = this._config;
    if (CONTRACTS[c.contract]) return this._contentSimple();
    const per = PERIODS.find((p) => p.key === this._tab) || PERIODS[1];
    const cur = currentPoste(this._st(c.tarif)?.state);
    const rows = POSTES.map((p) => {
      const id = `${c.prefix}${p.k}${c[per.cfg]}`;
      const kwh = this._num(id);
      const price = this._num(`${c.price_prefix}${p.k}`) ?? this._num(`${c.source_prefix}${p.en}`);
      return { p, id, kwh, price, cost: kwh !== null && price !== null ? kwh * price : null };
    });
    const sumK = rows.reduce((a, r) => a + (r.kwh || 0), 0);
    const sumE = rows.reduce((a, r) => a + (r.cost || 0), 0);
    const anyCost = rows.some((r) => r.cost !== null);
    const split = sumK > 0
      ? `<div class="bar en-split">${rows.filter((r) => r.kwh > 0).map((r) => `<i class="s-${r.p.c} s-${r.p.h}" style="width:${(r.kwh / sumK) * 100}%" title="${posteLabel(r.p)} : ${kwhFmt(r.kwh)} kWh"></i>`).join("")}</div>`
      : "";
    const table = `<table class="en-t">
        <thead><tr><th>Poste</th><th>kWh</th><th>Part</th><th>Prix</th>${anyCost ? "<th>Coût</th>" : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.p.k === cur ? "cur" : ""}" data-entity="${esc(r.id)}">
          <td><i class="sq s-${r.p.c} s-${r.p.h}"></i>${posteLabel(r.p)}${r.p.k === cur ? '<span class="now">en cours</span>' : ""}</td>
          <td>${kwhFmt(r.kwh)}</td>
          <td>${sumK > 0 && r.kwh !== null ? `${fmt((r.kwh / sumK) * 100, 0)} %` : "—"}</td>
          <td>${r.price !== null ? fmt(r.price, 4) : "—"}</td>
          ${anyCost ? `<td>${eur(r.cost)}</td>` : ""}
        </tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${kwhFmt(sumK)}</td><td></td><td>${sumK > 0 && anyCost ? fmt(sumE / sumK, 4) : ""}</td>${anyCost ? `<td>${eur(sumE)}</td>` : ""}</tr></tfoot>
      </table>`;
    const body = `${this._tabs(PERIODS)}
      <div class="en-sum"><div><span>Énergie</span><b>${kwhFmt(sumK)} kWh</b></div>${anyCost ? `<div><span>Coût énergie</span><b>${eur(sumE)}</b></div>` : ""}</div>
      ${split}${table}
      ${anyCost ? `<footer>Coût calculé avec le prix actuel de chaque poste, hors abonnement.</footer>` : ""}`;
    return { sub: per.label, right: this._postePill(c.tarif), body };
  }
}

/* ------------------------------------------------------- 4. prix Tempo */

class LinkyTempoPrixCard extends EnergyBase {
  static DEFAULTS = {
    title: "",
    contract: "tempo", // tempo, hchp ou base
    price_hc: "", price_hp: "", price_base: "", // HC/HP et Base : prix du kWh (nombre ou entité)
    price_prefix: "sensor.tempo_prix_",
    source_prefix: "sensor.myelectricaldata_tempo_price_",
    fallback_prefix: "input_number.tempo_tarif_",
    current: "sensor.tempo_tarif_ttc_actuel",
    tarif: "sensor.lixee_current_price",
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-tempo-prix-card-editor");
  }

  setConfig(config) {
    const contract = CONTRACTS[config?.contract] ? config.contract : "tempo";
    super.setConfig({ ...config, title: config?.title || (contract === "tempo" ? "Prix Tempo" : contract === "hchp" ? "Prix HC / HP" : "Prix du kWh") });
    // HC/HP et Base : le capteur de prix en cours n'est lu que s'il est choisi (le défaut est celui du paquet Tempo)
    this._ownCurrent = !!config?.current;
  }

  /** Contrats HC/HP et Base : prix saisis, poste en cours, écart HP / HC. */
  _contentSimple() {
    const c = this._config;
    const postes = CONTRACTS[c.contract];
    const cur = c.contract === "hchp" ? currentHcHp(this._st(this._tarif(c.tarif))?.state) : null;
    const vals = postes.map((p) => ({ p, v: priceOpt(this, c[`price_${p.k}`]), id: typeof c[`price_${p.k}`] === "string" && c[`price_${p.k}`].includes(".") ? c[`price_${p.k}`] : "" }));
    if (!vals.some((x) => x.v !== null)) {
      return { sub: "Prix TTC du kWh", body: `<div class="empty">Aucun prix saisi<span>Indiquez le prix TTC du kWh${c.contract === "hchp" ? " en heures creuses et en heures pleines" : ""} dans l'éditeur de la carte (nombre, ex. 0,2016, ou entité).</span></div>` };
    }
    const now = (this._ownCurrent ? this._num(c.current) : null) ?? (cur ? vals.find((x) => x.p.k === cur)?.v ?? null : postes.length === 1 ? vals[0].v : null);
    const hc = vals.find((x) => x.p.k === "hc")?.v, hp = vals.find((x) => x.p.k === "hp")?.v;
    const cells = vals.map(({ p, v, id }) => `<div class="pcell ${p.cls} ${p.k === cur ? "cur" : ""}" data-entity="${esc(id)}">
        <div class="pcell-h"><span class="dot ${p.k === "hc" ? "d-hc" : p.k === "hp" ? "d-hp" : ""}"></span>${p.label}${p.k === cur ? '<span class="now">en cours</span>' : ""}</div>
        <div class="pcell-v">${v !== null ? fmt(v, 4) : "—"}<span>€/kWh</span></div>
      </div>`).join("");
    const body = `<div class="pgrid p-${postes.length}">${cells}</div>
      <div class="en-sum">
        ${now !== null ? `<div${this._ownCurrent && this._st(c.current) ? ` data-entity="${esc(c.current)}"` : ""}><span>Prix en ce moment</span><b>${priceFmt(now)}</b></div>` : ""}
        ${hc > 0 && hp > 0 ? `<div><span>Heures pleines par rapport aux heures creuses</span><b>+ ${fmt((hp / hc - 1) * 100, 0)} %</b></div>` : ""}
      </div>`;
    const pill = cur ? this._postePill(c.tarif) : "";
    return { sub: "Prix TTC du kWh", right: pill, body };
  }

  _watch() {
    const c = this._config;
    if (CONTRACTS[c.contract]) return [c.current, c.tarif, c.price_hc, c.price_hp, c.price_base].filter((x) => typeof x === "string" && x.includes("."));
    return [c.current, c.tarif, ...POSTES.flatMap((p) => [`${c.price_prefix}${p.k}`, `${c.source_prefix}${p.en}`, `${c.fallback_prefix}${p.k}`])];
  }

  _content() {
    const c = this._config;
    if (CONTRACTS[c.contract]) return this._contentSimple();
    const cur = currentPoste(this._st(c.tarif)?.state);
    const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.00005;
    let issues = 0;
    // prix affiché : capteur des prix utilisés s'il existe, sinon MyElectricalData, sinon la valeur de secours
    const shown = (p) => {
      const used = this._num(`${c.price_prefix}${p.k}`), med = this._num(`${c.source_prefix}${p.en}`), fb = this._num(`${c.fallback_prefix}${p.k}`);
      return used !== null ? [used, `${c.price_prefix}${p.k}`] : med !== null ? [med, `${c.source_prefix}${p.en}`] : fb !== null ? [fb, `${c.fallback_prefix}${p.k}`] : [null, `${c.price_prefix}${p.k}`];
    };
    const cell = (p) => {
      const med = this._num(`${c.source_prefix}${p.en}`);
      const fb = this._num(`${c.fallback_prefix}${p.k}`);
      const [used, usedId] = shown(p);
      let src = "";
      let bad = false;
      if (same(used, med)) src = `<span class="src ok">MyElectricalData</span>`;
      else if (same(used, fb)) { src = `<span class="src warn">valeur de secours</span>`; bad = med === null || !same(med, fb); }
      else if (used !== null) { src = `<span class="src warn">autre source</span>`; bad = true; }
      if (med !== null && fb !== null && !same(med, fb)) bad = true;
      if (bad) issues++;
      const diff = med !== null && fb !== null && !same(med, fb) ? `<div class="pdiff">MyElectricalData ${priceFmt(med)} · secours ${priceFmt(fb)}</div>` : "";
      return `<div class="pcell ${TEMPO[p.c].cls} ${p.k === cur ? "cur" : ""} ${bad ? "bad" : ""}" data-entity="${esc(usedId)}">
        <div class="pcell-h"><span class="dot"></span>${p.h}${p.k === cur ? '<span class="now">en cours</span>' : ""}</div>
        <div class="pcell-v">${used !== null ? fmt(used, 4) : "—"}<span>€/kWh</span></div>
        ${src}${diff}
      </div>`;
    };
    const cols = ["blue", "white", "red"].map((col) => `<div class="pcol"><div class="pcol-h">${TEMPO[col].label}</div>${POSTES.filter((p) => p.c === col).map(cell).join("")}</div>`).join("");
    const vals = POSTES.map((p) => shown(p)[0]);
    const min = Math.min(...vals.filter((v) => v !== null));
    const max = Math.max(...vals.filter((v) => v !== null));
    const now = this._num(c.current);
    const body = `
      ${issues ? `<div class="en-alert warn"><ha-icon icon="mdi:alert-outline"></ha-icon><div><b>${issues} prix à vérifier.</b> La source MyElectricalData est indisponible ou différente de la valeur de secours.</div></div>` : ""}
      <div class="pgrid">${cols}</div>
      <div class="en-sum">
        ${now !== null ? `<div data-entity="${esc(c.current)}"><span>Prix en ce moment</span><b>${priceFmt(now)}</b></div>` : ""}
        ${Number.isFinite(min) && Number.isFinite(max) && min > 0 ? `<div><span>Écart entre le moins cher et le plus cher</span><b>× ${fmt(max / min, 1)}</b></div>` : ""}
      </div>`;
    return { sub: "Prix TTC du kWh par poste", right: this._postePill(c.tarif), body };
  }
}

/* ------------------------------------------------------- 5. contrôle du cycle */

class LinkyCycleCard extends EnergyBase {
  static DEFAULTS = {
    title: "Contrôle du cycle",
    control: "sensor.tempo_controle_compteurs_actifs",
    baseline_prefix: "input_number.baseline_",
    cycle_prefix: "sensor.conso_",
    cycle_suffix: "_cycle_en_cours",
    total: "sensor.conso_totale_cycle_en_cours",
    archive: "input_number.archive_conso_cycle_precedent",
    cycle_start: "10-01",
    month_prefix: "sensor.tempo_",
    month_suffix: "_energie_ce_mois",
    // « Nouveau cycle » n'est volontairement pas proposé : il remet le cycle à zéro et écrase l'archive.
    scripts: ["script.tempo_recaler_cycle_01_10", "script.tempo_restaurer_compteurs"],
    automations: ["automation.tempo_alerte_baselines_perdues", "automation.tempo_nouveau_cycle_de_facturation_1er_octobre"],
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-cycle-card-editor");
  }

  _watch() {
    const c = this._config;
    return [c.control, c.total, c.archive, ...POSTES.flatMap((p) => [`${c.baseline_prefix}${p.k}`, `${c.cycle_prefix}${p.k}${c.cycle_suffix}`, `${c.month_prefix}${p.k}${c.month_suffix}`]), ...(c.scripts || []), ...(c.automations || [])];
  }

  _content() {
    const c = this._config;
    const ctl = this._st(c.control);
    const ctlNum = this._num(c.control);
    const rows = POSTES.map((p) => ({ p, b: this._num(`${c.baseline_prefix}${p.k}`), bid: `${c.baseline_prefix}${p.k}`, v: this._num(`${c.cycle_prefix}${p.k}${c.cycle_suffix}`), vid: `${c.cycle_prefix}${p.k}${c.cycle_suffix}` }));
    const zero = rows.filter((r) => r.b === 0).length;
    const missing = rows.filter((r) => r.b === null).length;
    const negative = rows.filter((r) => r.v !== null && r.v < 0).length;
    // Pendant le premier mois du cycle (début le 1er), compteurs du cycle et du mois doivent être égaux.
    const [cm, cd] = String(c.cycle_start || "10-01").split("-").map(Number);
    const firstMonth = cd === 1 && new Date().getMonth() + 1 === cm;
    for (const r of rows) {
      r.m = firstMonth ? this._num(`${c.month_prefix}${r.p.k}${c.month_suffix}`) : null;
      r.gap = r.m !== null && r.v !== null ? r.v - r.m : null;
    }
    const gaps = rows.filter((r) => r.gap !== null && Math.abs(r.gap) >= 0.5);
    const ok = !zero && !negative && !missing && !gaps.length;
    const ctlTxt = ctl ? `${ctl.state}${ctl.attributes?.unit_of_measurement ? ` ${ctl.attributes.unit_of_measurement}` : ""}` : null;

    const table = `<table class="en-t">
        <thead><tr><th>Poste</th><th>Baseline (index kWh)</th><th>Cycle en cours</th>${firstMonth ? "<th>Ce mois</th>" : ""}</tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td><i class="sq s-${r.p.c} s-${r.p.h}"></i>${posteLabel(r.p)}</td>
          <td data-entity="${esc(r.bid)}" class="${r.b === 0 || r.b === null ? "bad" : ""}">${r.b !== null ? fmt(r.b, 1) : "—"}</td>
          <td data-entity="${esc(r.vid)}" class="${(r.v !== null && r.v < 0) || (r.gap !== null && Math.abs(r.gap) >= 0.5) ? "bad" : ""}">${kwhFmt(r.v)} kWh</td>
          ${firstMonth ? `<td data-entity="${esc(`${c.month_prefix}${r.p.k}${c.month_suffix}`)}">${kwhFmt(r.m)} kWh</td>` : ""}
        </tr>`).join("")}</tbody>
        <tfoot><tr><td>Total</td><td></td><td data-entity="${esc(c.total)}">${kwhFmt(this._num(c.total))} kWh</td>${firstMonth ? `<td>${kwhFmt(rows.reduce((a, r) => a + (r.m || 0), 0))} kWh</td>` : ""}</tr></tfoot>
      </table>`;

    const autos = (c.automations || []).map((id) => {
      const s = this._st(id);
      if (!s) return `<div class="en-row miss"><ha-icon icon="mdi:robot-off-outline"></ha-icon><span>${esc(id)}</span><b>introuvable</b></div>`;
      const on = s.state === "on";
      return `<div class="en-row" data-entity="${esc(id)}"><ha-icon icon="${on ? "mdi:robot-outline" : "mdi:robot-off-outline"}"></ha-icon><span>${esc(this._name(id))}<small>dernier déclenchement : ${ago(s.attributes?.last_triggered)}</small></span><b class="${on ? "ok" : "warn"}">${on ? "active" : "désactivée"}</b></div>`;
    }).join("");

    const scripts = (c.scripts || []).map((id) => {
      const s = this._st(id);
      if (!s) return "";
      const armed = this._armed === id;
      const running = s.state === "on";
      return `<button class="en-btn ${armed ? "armed" : ""}" data-run="${esc(id)}" ${running ? "disabled" : ""}>
          <ha-icon icon="${esc(s.attributes?.icon || "mdi:play-circle-outline")}"></ha-icon>
          <span>${running ? "En cours…" : armed ? "Confirmer ?" : esc(this._name(id))}</span>
        </button>`;
    }).join("");

    const status = ok
      ? `<div class="en-ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon><div><b>Compteurs du cycle cohérents.</b> Les 6 baselines sont renseignées${ctlTxt ? ` · contrôle : ${esc(ctlTxt)}` : ""}.</div></div>`
      : `<div class="en-alert"><ha-icon icon="mdi:alert-outline"></ha-icon><div><b>À vérifier :</b> ${[gaps.length ? `écart avec les compteurs du mois sur ${gaps.map((r) => `${posteLabel(r.p)} (${r.gap > 0 ? "+" : ""}${fmt(r.gap, 1)} kWh)`).join(", ")}` : "", zero ? `${zero} baseline${zero > 1 ? "s" : ""} à 0` : "", missing ? `${missing} baseline${missing > 1 ? "s" : ""} introuvable${missing > 1 ? "s" : ""}` : "", negative ? `${negative} compteur${negative > 1 ? "s" : ""} négatif${negative > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ")}. ${gaps.length ? " Le cycle a commencé le 1er : ses compteurs devraient égaler ceux du mois. Un des deux est faux (compteur du mois ou baseline) : vérifiez avec les données Enedis avant de corriger." : " Le script de restauration peut les recaler."}</div></div>`;

    const body = `${status}
      ${table}
      ${this._num(c.archive) !== null ? `<div class="en-sum"><div data-entity="${esc(c.archive)}"><span>Cycle précédent archivé</span><b>${fmt(this._num(c.archive), 0)} kWh</b></div>${ctlNum !== null || ctlTxt ? `<div data-entity="${esc(c.control)}"><span>Compteurs actifs</span><b>${esc(ctlTxt)}</b></div>` : ""}</div>` : ""}
      ${autos ? `<div class="en-sec"><div class="chart-h"><span>Automatisations</span></div>${autos}</div>` : ""}
      ${scripts ? `<div class="en-sec"><div class="chart-h"><span>Actions</span><span>2 clics pour confirmer</span></div><div class="en-btns">${scripts}</div></div>` : ""}`;
    return { sub: "Baselines, automatisations et scripts", right: "", body, cls: ok ? "" : "en-over" };
  }
}

/* ------------------------------------------------------- 6. état des services Enedis */

/** Services Data Connect de production, dans l'ordre de la page Enedis : suffixe de l'entité, nom, rôle. */
const ENEDIS_SERVICES = [
  { k: "authorize", n: "Authorize", r: "Consentement, connexion au compte Enedis" },
  { k: "services_souscrits", n: "Services souscrits", r: "Liste des services du compteur" },
  { k: "mesures", n: "Mesures", r: "Consommation, production, courbe de charge" },
  { k: "donnees_generales", n: "Données générales", r: "Adresse et caractéristiques du compteur" },
  { k: "alimentation", n: "Alimentation", r: "Raccordement du point de livraison" },
  { k: "situation_contractuelle", n: "Situation contractuelle", r: "Contrat en cours" },
  { k: "synthese_contractuelle", n: "Synthèse contractuelle", r: "Puissance, date de mise en service" },
  { k: "situation_comptage", n: "Situation comptage", r: "Heures creuses, comptage" },
];
const ENEDIS_PAGE = "https://datahub-enedis.fr/services-api/etat-des-services/";

/** État d'un capteur : « up » / « down » (attribut data-status de la page Enedis), le reste est inconnu. */
const enedisState = (st) => {
  const v = String(st?.state ?? "").trim().toLowerCase();
  if (v === "up" || v === "en service") return "up";
  if (v === "down" || v.startsWith("indisponible")) return "down";
  return "unknown";
};

/** Heure d'un changement : « 16:06 » aujourd'hui, « 28/10 à 16:06 » avant. */
const sinceTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} à ${hm}`;
};

class LinkyEnedisStatusCard extends EnergyBase {
  static DEFAULTS = {
    title: "État des services Enedis",
    prefix: "sensor.enedis_datahub_",
    show_roles: true,
    show_link: true,
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-enedis-status-card-editor");
  }

  getCardSize() {
    return 4;
  }

  /** Capteurs suivis : ceux du préfixe, services connus d'abord dans l'ordre de la page, puis les autres. */
  _ids() {
    const pre = this._config.prefix || "";
    const found = pre ? Object.keys(this._hass?.states || {}).filter((id) => id.startsWith(pre)) : [];
    const known = ENEDIS_SERVICES.map((s) => `${pre}${s.k}`).filter((id) => found.includes(id));
    return [...known, ...found.filter((id) => !known.includes(id)).sort()];
  }

  _watch() {
    return this._ids();
  }

  _content() {
    const c = this._config;
    const ids = this._ids();
    if (!ids.length) {
      return {
        sub: "Data Connect, API de production",
        body: `<div class="en-alert warn"><ha-icon icon="mdi:alert-outline"></ha-icon><div><b>Aucun capteur trouvé</b> pour le préfixe
          <code>${esc(c.prefix)}</code>. Créez les capteurs avec l'intégration Scrape (voir le README de la carte).</div></div>`,
      };
    }
    const rows = ids.map((id) => {
      const st = this._st(id);
      const svc = ENEDIS_SERVICES.find((s) => `${c.prefix}${s.k}` === id);
      const name = svc?.n || String(st?.attributes?.friendly_name || id).replace(/^Enedis DataHub\s*/i, "");
      return { id, st, svc, name, state: enedisState(st) };
    });
    const down = rows.filter((r) => r.state === "down");
    const unknown = rows.filter((r) => r.state === "unknown");
    const up = rows.filter((r) => r.state === "up");
    // Home Assistant ne réécrit pas un capteur Scrape dont la valeur ne change pas : seule l'heure du
    // dernier changement d'état est fiable (last_reported et last_updated n'indiquent pas la dernière lecture).
    const changed = rows.map((r) => r.st?.last_changed).filter((t) => t && !Number.isNaN(Date.parse(t))).sort().pop();

    const banner = down.length
      ? `<div class="en-alert"><ha-icon icon="mdi:transmission-tower-off"></ha-icon><div><b>Incident Enedis en cours</b> :
          ${down.map((r) => esc(r.name)).join(", ")} ${down.length > 1 ? "sont indisponibles" : "est indisponible"}.
          Les données de MyElectricalData reprendront seules au retour du service.</div></div>`
      : unknown.length === rows.length
        ? `<div class="en-alert warn"><ha-icon icon="mdi:help-circle-outline"></ha-icon><div><b>État inconnu</b> : la page Enedis
            n'a pas pu être lue. Vérifiez l'intégration Scrape.</div></div>`
        : `<div class="en-ok"><ha-icon icon="mdi:check-circle-outline"></ha-icon><div><b>Tous les services sont en service.</b>
            ${unknown.length ? `${unknown.length} état${unknown.length > 1 ? "s" : ""} inconnu${unknown.length > 1 ? "s" : ""}.` : ""}</div></div>`;

    const ICON = { up: "mdi:check-circle", down: "mdi:close-circle", unknown: "mdi:help-circle-outline" };
    const LABEL = { up: "En service", down: "Indisponible", unknown: "Inconnu" };
    const list = rows.map((r) => `<div class="en-row st-${r.state}" data-entity="${esc(r.id)}">
        <ha-icon icon="${ICON[r.state]}"></ha-icon>
        <span>${esc(r.name)}${c.show_roles && r.svc ? `<small>${esc(r.svc.r)}</small>` : ""}</span>
        <b>${LABEL[r.state]}</b>
      </div>`).join("");

    const pillCls = down.length ? "st-down" : unknown.length ? "st-unknown" : "st-up";
    const right = `<div class="pill ${pillCls}"><span class="dot"></span><span class="pill-l">En service</span><span class="pill-v">${up.length}/${rows.length}</span></div>`;
    const foot = `<div class="en-foot"><span>Dernier changement : ${sinceTime(changed)}</span>${c.show_link
      ? `<a href="${ENEDIS_PAGE}" target="_blank" rel="noopener noreferrer">Page Enedis DataHub<ha-icon icon="mdi:open-in-new"></ha-icon></a>` : ""}</div>`;

    return {
      sub: "Data Connect, API de production",
      right,
      cls: down.length ? "en-over" : "",
      body: `${banner}<div class="en-sec">${list}</div>${foot}`,
    };
  }
}

const EN_STYLE = `<style>
.co2-hero { position: relative; }
.c-1 { --co2: #2fbf71; } .c-2 { --co2: #96d21f; } .c-3 { --co2: #f0c43a; } .c-4 { --co2: #f08a3b; } .c-5 { --co2: #e04848; }
.co2-hero .en-hero-v { color: var(--co2, var(--med-text)); }
.co2-lvl { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; font-size: .85rem; color: var(--co2); }
.co2-lvl i { width: 9px; height: 9px; border-radius: 50%; background: var(--co2); }
.co2-scale { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; margin-top: 8px; }
.co2-scale i { height: 6px; border-radius: 4px; background: var(--co2); opacity: .3; }
.co2-scale i.on { opacity: 1; }
.co2-mix { margin: 10px 12px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); cursor: pointer; }
.co2-mix-h { display: flex; justify-content: space-between; font-size: .74rem; color: var(--med-muted); }
.co2-mix-h b { color: var(--med-text); font-size: .85rem; }
.co2-bar { margin: 6px 0; height: 10px; }
.co2-bar .lc { background: #2fbf71; } .co2-bar .fo { background: #8a6d5b; }
.co2-chart svg { height: 90px; }
.co2-chart rect { fill: var(--co2); opacity: .55; }
.co2-chart rect.best { opacity: 1; stroke: var(--med-text); stroke-width: 1; vector-effect: non-scaling-stroke; }
.co2-l { fill: none; stroke: var(--med-text); stroke-width: 1.2; opacity: .5; vector-effect: non-scaling-stroke; }
.co2-ax { display: flex; justify-content: space-between; font-size: .68rem; color: var(--med-muted); margin: 2px 4px 0; }
ha-card { display: block; padding-bottom: 14px; }
ha-card.en-over { border-color: var(--t-red); }
.en-alert, .en-ok { display: flex; gap: 10px; align-items: center; margin: 4px 12px 0; padding: 10px 12px; border-radius: 12px; font-size: .84rem;
  background: color-mix(in srgb, var(--t-red) 16%, transparent); border: 1px solid var(--t-red); }
.en-alert ha-icon { color: var(--t-red); flex: none; }
.en-alert.warn { background: color-mix(in srgb, #f0a33a 14%, transparent); border-color: #f0a33a; } .en-alert.warn ha-icon { color: #f0a33a; }
.en-ok { background: color-mix(in srgb, var(--med-down) 12%, transparent); border-color: color-mix(in srgb, var(--med-down) 60%, transparent); }
.en-ok ha-icon { color: var(--med-down); flex: none; }
.en-hero { margin: 8px 12px 0; padding: 14px 16px; border-radius: 14px; background: var(--med-surface); border: 1px solid var(--med-line); cursor: pointer; }
.en-hero-l { font-size: .82rem; color: var(--med-muted); }
.en-hero-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.en-hero-v { font-size: 2.4rem; font-weight: 700; line-height: 1.15; }
.en-hero-v span { font-size: .95rem; font-weight: 500; color: var(--med-muted); margin-left: 4px; }
.en-hero-n { font-size: .78rem; color: var(--med-muted); margin-top: 4px; }
.en-hero-n b { color: var(--med-text); font-weight: 600; }
.en-proj { text-align: right; font-size: .78rem; color: var(--med-muted); display: flex; flex-direction: column; }
.en-proj b { font-size: 1.3rem; color: var(--med-text); }
.g-bar { position: relative; height: 10px; border-radius: 6px; background: var(--med-line); margin: 10px 0 6px; }
.g-bar.cyc { height: 6px; }
.g-bar i { display: block; height: 100%; border-radius: 6px; background: var(--med-muted); }
.g-bar.b-ok i { background: linear-gradient(90deg, var(--med-blue), var(--med-green)); }
.g-bar.b-warn i { background: #f0a33a; } .g-bar.b-alert i { background: var(--t-red); }
.g-bar .tick { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--med-bg); opacity: .7; }
.g-bar .peak { position: absolute; top: -4px; bottom: -4px; width: 3px; margin-left: -1.5px; border-radius: 2px; background: var(--med-text); }
.g-n { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: .78rem; color: var(--med-muted); }
.g-n b { color: var(--med-text); font-weight: 600; }
.en-tiles { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)) !important; }
.en-tiles .tile { cursor: pointer; }
.en-tiles .tile-v { font-size: 1.3rem; }
.tile.t-warn { border-color: #f0a33a; }
em.warn { color: var(--med-up); font-style: normal; font-weight: 600; } em.ok { color: var(--med-down); font-style: normal; font-weight: 600; }
.en-tabs { display: flex; gap: 4px; margin: 6px 12px 0; padding: 3px; border-radius: 10px; background: var(--med-surface); border: 1px solid var(--med-line); }
.en-tabs button { flex: 1; border: 0; background: none; color: var(--med-muted); font: inherit; font-size: .8rem; padding: 6px 0; border-radius: 8px; cursor: pointer; }
.en-tabs button.on { background: var(--med-blue); color: #fff; font-weight: 600; }
.en-sum { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 12px 0; }
.en-sum > div { flex: 1 1 140px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); display: flex; flex-direction: column; font-size: .78rem; color: var(--med-muted); }
.en-sum > div[data-entity] { cursor: pointer; }
.en-sum b { font-size: 1.15rem; color: var(--med-text); }
.bar.en-split { margin: 10px 14px 0; height: 10px; }
.bar .s-blue.s-HC, .sq.s-blue.s-HC { background: #8fb0f0; } .bar .s-blue.s-HP, .sq.s-blue.s-HP { background: var(--t-blue); }
.bar .s-white.s-HC, .sq.s-white.s-HC { background: #f2f5f9; } .bar .s-white.s-HP, .sq.s-white.s-HP { background: #aab3c0; }
.bar .s-red.s-HC, .sq.s-red.s-HC { background: #f39a9a; } .bar .s-red.s-HP, .sq.s-red.s-HP { background: var(--t-red); }
ha-card.light .bar .s-white.s-HC, ha-card.light .sq.s-white.s-HC { background: #dbe2ec; }
.sq { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 8px; vertical-align: -1px; }
.en-t { width: calc(100% - 24px); margin: 10px 12px 0; border-collapse: collapse; font-size: .82rem; color: var(--med-text); }
.en-t th { font-weight: 500; color: var(--med-muted); text-align: right; padding: 4px 6px; white-space: nowrap; font-size: .74rem; }
.en-t th:first-child, .en-t td:first-child { text-align: left; }
.en-t td { color: var(--med-text); text-align: right; padding: 6px; border-top: 1px solid var(--med-line); white-space: nowrap; }
.en-t td[data-entity], .en-t tr[data-entity] { cursor: pointer; }
.en-t tr.cur td { background: var(--med-surface); font-weight: 700; }
.en-t td.bad { color: var(--t-red); font-weight: 700; }
.en-t tfoot td { font-weight: 700; border-top: 2px solid var(--med-line); }
.now { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: .66rem; font-weight: 600; background: var(--med-blue); color: #fff; vertical-align: 1px; }
.pgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 8px 12px 0; }
.pgrid.p-2 { grid-template-columns: repeat(2, 1fr); } .pgrid.p-1 { grid-template-columns: 1fr; }
.bar .s-hc, .sq.s-hc { background: var(--med-hc); } .bar .s-hp, .sq.s-hp { background: var(--med-hp); } .bar .s-base, .sq.s-base { background: var(--med-blue); }
.dot.d-hc { background: var(--med-hc); } .dot.d-hp { background: var(--med-hp); }
@container (max-width: 400px) { .pgrid { grid-template-columns: 1fr; } }
.pcol { display: flex; flex-direction: column; gap: 8px; }
.pcol-h { font-size: .8rem; color: var(--med-muted); padding-left: 4px; }
.pcell { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.pcell.cur { border-color: var(--med-blue); background: var(--med-surface); }
.pcell.bad { border-color: #f0a33a; }
.pcell-h { display: flex; align-items: center; gap: 6px; font-size: .78rem; color: var(--med-muted); }
.pcell-v { font-size: 1.25rem; font-weight: 700; }
.pcell-v span { font-size: .72rem; font-weight: 500; color: var(--med-muted); margin-left: 3px; }
.src { font-size: .68rem; } .src.ok { color: var(--med-down); } .src.warn { color: #f0a33a; }
.pdiff { font-size: .66rem; color: var(--med-muted); }
ha-card.light .t-white .dot { box-shadow: inset 0 0 0 1px #aab3c0; }
.en-sec { margin: 12px 12px 0; }
.en-row { display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-radius: 10px; cursor: pointer; font-size: .84rem; }
.en-row:hover { background: var(--med-surface); }
.en-row ha-icon { --mdc-icon-size: 20px; color: var(--med-muted); flex: none; }
.en-row span { flex: 1; display: flex; flex-direction: column; }
.en-row small { color: var(--med-muted); font-size: .72rem; }
.en-row b { font-size: .76rem; } .en-row b.ok { color: var(--med-down); } .en-row b.warn, .en-row.miss b { color: #f0a33a; }
.en-btns { display: flex; flex-wrap: wrap; gap: 8px; }
.en-btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 10px;
  border: 1px solid var(--med-line); background: var(--med-surface); font-size: .8rem; }
.en-btn ha-icon { --mdc-icon-size: 18px; color: var(--med-blue); }
.en-btn.armed { border-color: #f0a33a; background: color-mix(in srgb, #f0a33a 18%, transparent); font-weight: 700; }
.en-btn.armed ha-icon { color: #f0a33a; }
.en-btn[disabled] { opacity: .6; cursor: default; }
.en-btn:focus-visible { outline: 2px solid var(--med-blue); }
.en-row.st-up ha-icon { color: var(--med-down); } .en-row.st-up b { color: var(--med-down); }
.en-row.st-down ha-icon, .en-row.st-down b { color: var(--t-red); } .en-row.st-down { background: color-mix(in srgb, var(--t-red) 10%, transparent); }
.en-row.st-unknown ha-icon, .en-row.st-unknown b { color: #f0a33a; }
.pill.st-up .dot { background: var(--med-down); } .pill.st-down .dot { background: var(--t-red); } .pill.st-unknown .dot { background: #f0a33a; }
.pill.st-down { border-color: var(--t-red); }
.en-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 16px 0; font-size: .74rem; color: var(--med-muted); }
.en-foot a { color: var(--med-blue); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.en-foot a ha-icon { --mdc-icon-size: 14px; }
.en-alert code { font-size: .78rem; }
</style>`;

/* ------------------------------------------------------- 7. intensité carbone */

/** Échelle de couleur de l'intensité carbone (gCO₂eq/kWh), celle d'Electricity Maps simplifiée. */
const CO2_LEVELS = [[50, "Très faible", "c-1"], [150, "Faible", "c-2"], [300, "Moyenne", "c-3"], [500, "Élevée", "c-4"], [Infinity, "Très élevée", "c-5"]];
const co2Level = (v) => (v === null ? null : CO2_LEVELS.find(([max]) => v < max));

class LinkyCarboneCard extends EnergyBase {
  static DEFAULTS = {
    title: "Intensité carbone",
    intensity: "", // gCO2eq/kWh (Electricity Maps, trouvé seul)
    fossil: "", // % d'énergies fossiles du réseau
    energy_today: "", // consommation du jour (kWh), pour le CO₂ de la maison
    hours: 24,
    theme: "v2",
  };

  static getConfigElement() {
    return document.createElement("linky-carbone-card-editor");
  }

  /** Capteurs Electricity Maps (co2signal) : intensité et part fossile, trouvés par l'unité ou la plateforme. */
  _ids2() {
    const c = this._config, hass = this._hass;
    const reg = hass?.entities || {};
    const all = Object.keys(hass?.states || {}).filter((id) => id.startsWith("sensor."));
    const plat = all.filter((id) => reg[id]?.platform === "co2signal");
    const intensity = c.intensity || plat.find((id) => /co2|g\/kwh/i.test(this._unit(id))) || all.find((id) => /gco2(eq)?\/kwh/i.test(this._unit(id))) || null;
    const fossil = c.fossil || plat.find((id) => this._unit(id) === "%") || null;
    return { intensity, fossil };
  }

  _watch() {
    const { intensity, fossil } = this._ids2();
    return [intensity, fossil, this._config.energy_today].filter(Boolean);
  }

  _extraSig() {
    return this._hist ? this._hist.at : "";
  }

  connectedCallback() {
    clearInterval(this._timer);
    this._timer = setInterval(() => this._loadHist(), 15 * 60 * 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  set hass(hass) {
    const first = !this._hass;
    super.hass = hass;
    if (first || !this._hist) this._loadHist();
  }

  /** Moyennes horaires des dernières heures (statistiques longue durée de Home Assistant). */
  async _loadHist() {
    const { intensity } = this._ids2();
    if (!intensity || !this._hass?.callWS || this._loading) return;
    this._loading = true;
    const hours = Math.max(6, Math.min(168, Number(this._config.hours) || 24));
    try {
      const res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: new Date(Date.now() - hours * 3600e3).toISOString(),
        statistic_ids: [intensity],
        period: "hour",
        types: ["mean"],
      });
      const pts = (res?.[intensity] || []).map((r) => ({ t: typeof r.start === "number" ? r.start : Date.parse(r.start), v: r.mean })).filter((p) => Number.isFinite(p.v));
      this._hist = { pts, at: Date.now() };
    } catch (e) {
      this._hist = { pts: [], at: Date.now() };
    } finally {
      this._loading = false;
      this._render(true);
    }
  }

  _content() {
    const c = this._config;
    const { intensity, fossil } = this._ids2();
    if (!intensity) {
      return { body: `<div class="empty">Intensité carbone introuvable<span>Ajoutez l'intégration Electricity Maps (CO2 Signal) dans Paramètres › Appareils et services, ou choisissez le capteur dans l'éditeur.</span></div>` };
    }
    const v = this._num(intensity);
    const lvl = co2Level(v);
    const fos = this._num(fossil);
    const pts = this._hist?.pts || [];
    const vals = pts.map((p) => p.v);
    const min = vals.length ? pts.reduce((a, b) => (b.v < a.v ? b : a)) : null;
    const max = vals.length ? pts.reduce((a, b) => (b.v > a.v ? b : a)) : null;
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const hh = (t) => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const kwh = this._num(c.energy_today);
    const kg = kwh !== null && (avg ?? v) !== null ? (kwh * (avg ?? v)) / 1000 : null;
    const zone = this._st(intensity)?.attributes?.country_code;

    // courbe des moyennes horaires, colorée par niveau
    let chart = "";
    if (pts.length > 2) {
      const W = 300, H = 70, top = Math.max(...vals) * 1.15 || 1;
      const x = (i) => (i / (pts.length - 1)) * W, y = (val) => H - (val / top) * H;
      const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
      const bars = pts.map((p, i) => `<rect class="${co2Level(p.v)[2]}${p === min ? " best" : ""}" x="${(x(i) - W / pts.length / 2 + 0.6).toFixed(1)}" y="${y(p.v).toFixed(1)}" width="${Math.max(1, W / pts.length - 1.2).toFixed(1)}" height="${(H - y(p.v)).toFixed(1)}" rx="1"><title>${hh(p.t)} · ${fmt(p.v, 0)} g/kWh</title></rect>`).join("");
      chart = `<div class="chart co2-chart"><div class="chart-h"><span>${pts.length} dernières heures, moyenne par heure</span><span>${fmt(avg, 0)} g/kWh en moyenne</span></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Intensité carbone par heure">${bars}<path class="co2-l" d="${line}"/></svg>
        <div class="co2-ax"><span>${hh(pts[0].t)}</span><span>${hh(pts[pts.length - 1].t)}</span></div></div>`;
    }
    const body = `
      <div class="en-hero co2-hero ${lvl ? lvl[2] : ""}" data-entity="${esc(intensity)}">
        <div class="en-hero-l">Électricité du réseau${zone ? ` (${esc(zone)})` : ""}, en ce moment</div>
        <div class="en-hero-v">${v !== null ? fmt(v, 0) : "—"}<span>gCO₂eq/kWh</span></div>
        ${lvl ? `<div class="co2-lvl"><i></i>${lvl[1]}</div>` : ""}
        <div class="co2-scale">${CO2_LEVELS.map(([m, l, cls]) => `<i class="${cls}${lvl && lvl[2] === cls ? " on" : ""}" title="${l}${Number.isFinite(m) ? ` (moins de ${m})` : ""}"></i>`).join("")}</div>
      </div>
      ${fos !== null ? `<div class="co2-mix" data-entity="${esc(fossil)}"><div class="co2-mix-h"><span>Bas carbone (nucléaire, renouvelables)</span><span>Fossiles</span></div>
        <div class="bar co2-bar"><i class="lc" style="width:${Math.max(0, 100 - fos)}%"></i><i class="fo" style="width:${Math.min(100, fos)}%"></i></div>
        <div class="co2-mix-h"><b>${fmt(100 - fos, 1)} %</b><b>${fmt(fos, 1)} %</b></div></div>` : ""}
      ${min || kg !== null ? `<div class="tiles en-tiles">
        ${min ? `<div class="tile"><div class="tile-l">Plus bas sur ${pts.length} h</div><div class="tile-v">${fmt(min.v, 0)}<span>g/kWh</span></div><div class="tile-n">à ${hh(min.t)}</div></div>` : ""}
        ${max ? `<div class="tile"><div class="tile-l">Plus haut sur ${pts.length} h</div><div class="tile-v">${fmt(max.v, 0)}<span>g/kWh</span></div><div class="tile-n">à ${hh(max.t)}</div></div>` : ""}
        ${kg !== null ? `<div class="tile" data-entity="${esc(c.energy_today)}"><div class="tile-l">CO₂ de la maison aujourd'hui</div><div class="tile-v">${kg < 1 ? `${fmt(kg * 1000, 0)}<span>g</span>` : `${fmt(kg, 1)}<span>kg</span>`}</div><div class="tile-n">${fmt(kwh, 1)} kWh × ${fmt(avg ?? v, 0)} g/kWh</div></div>` : ""}
      </div>` : ""}
      ${chart}
      <footer>Données Electricity Maps, mesures passées (pas de prévision). Plus c'est vert, plus l'électricité du réseau est bas carbone.</footer>`;
    return { sub: lvl ? `Carbone : ${lvl[1].toLowerCase()}` : "Réseau électrique", body };
  }
}

/* ------------------------------------------------------------------ style */

const STYLE = `<style>
:host {
  --med-bg: #1a2434; --med-surface: #212d40; --med-line: #2f3d55;
  --med-text: #e7edf5; --med-muted: #8fa0b8;
  --med-green: #96d21f; --med-blue: #1d93e3;
  --med-hc: #4a7bd8; --med-hp: #d27333;
  --t-blue: #3f7ff0; --t-white: #e9eef4; --t-red: #ee4a4a;
  --med-up: #f08a4b; --med-down: #5fcf8a;
}
ha-card { background: var(--med-bg); color: var(--med-text); border: 1px solid var(--med-line);
  border-radius: 18px; overflow: hidden; font-variant-numeric: tabular-nums; container-type: inline-size; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand svg { width: 34px; height: 34px; fill: none; }
.brand .house { stroke: var(--med-green); stroke-width: 2.4; stroke-linejoin: round; stroke-linecap: round; }
.brand .bolt { fill: var(--med-blue); }
.title { font-size: 1.15rem; font-weight: 700; letter-spacing: .2px; }
.sub { font-size: .78rem; color: var(--med-muted); }
.tempo { display: flex; gap: 8px; }
.pill { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px;
  background: var(--med-surface); border: 1px solid var(--med-line); font-size: .78rem; }
.pill-l { color: var(--med-muted); }
.pill-v { font-weight: 600; }
.dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; background: var(--med-muted); flex: none; }
.t-blue .dot { background: var(--t-blue); } .t-white .dot { background: var(--t-white); } .t-red .dot { background: var(--t-red); }
.t-none .pill-v { color: var(--med-muted); font-weight: 400; }
.quotas { display: flex; align-items: center; gap: 14px; padding: 0 18px 10px; font-size: .82rem; }
.quota { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
.quota small { color: var(--med-muted); font-weight: 400; }
.quota-l { color: var(--med-muted); }

.hero { margin: 4px 12px 0; padding: 16px; border-radius: 14px; background: var(--med-surface);
  border: 1px solid var(--med-line); display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; }
.hero-l { color: var(--med-muted); font-size: .85rem; }
.hero-v { font-size: 2.4rem; font-weight: 700; line-height: 1.1; }
.hero-v span, .tile-v span { font-size: .9rem; font-weight: 500; color: var(--med-muted); margin-left: 4px; }
.hero-r { text-align: right; align-self: center; }
.cost { font-size: 1.6rem; font-weight: 700; color: var(--med-green); }
.cost.none { color: var(--med-muted); }
.cost.est { color: var(--med-text); opacity: .85; }
.hero-p { font-size: .75rem; color: var(--med-muted); margin-top: 6px; }
.cost-l { font-size: .75rem; color: var(--med-muted); max-width: 160px; }
.evo { font-size: .8rem; font-weight: 600; margin-top: 2px; }
.evo.up { color: var(--med-up); } .evo.down { color: var(--med-down); }
.split { grid-column: 1 / -1; margin-top: 6px; }
.split.wait { font-size: .8rem; color: var(--med-muted); border-top: 1px dashed var(--med-line); padding-top: 8px; }
.bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: var(--med-line); }
.bar i { display: block; } .bar .hc { background: var(--med-hc); } .bar .hp { background: var(--med-hp); }
.split-l { display: flex; justify-content: space-between; font-size: .78rem; margin-top: 6px; }
.k-hc { color: #8fb0f0; } .k-hp { color: #eaa070; }

.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 10px 12px 0; }
@container (min-width: 620px) { .tiles { grid-template-columns: repeat(4, 1fr); } }
@container (min-width: 620px) { .tiles.six { grid-template-columns: repeat(3, 1fr); } }
.tile { padding: 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.tile-l { font-size: .78rem; color: var(--med-muted); }
.tile-v { font-size: 1.35rem; font-weight: 700; margin-top: 2px; }
.tile-n { font-size: .72rem; color: var(--med-muted); margin-top: 4px; }

.chart { margin: 14px 12px 0; }
.chart-h { display: flex; justify-content: space-between; font-size: .82rem; color: var(--med-muted); margin: 0 4px 6px; }
.legend { display: flex; align-items: center; gap: 6px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 6px; }
.legend .k-hc { background: var(--med-hc); } .legend .k-hp { background: var(--med-hp); }
.chart svg { width: 100%; height: 130px; display: block; }
.chart rect.hc { fill: var(--med-hc); } .chart rect.hp { fill: var(--med-hp); }
.chart rect.partial { fill: var(--med-muted); opacity: .35; }
.chart g.est { opacity: .45; }
.chart rect.sel { fill: rgba(255,255,255,.06); }
.chart rect.hit { fill: transparent; cursor: pointer; }
.days { display: grid; margin-top: 4px; }
.day { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 4px 0; border-radius: 8px; font-size: .68rem; color: var(--med-muted); text-transform: capitalize; }
.day b { color: var(--med-text); font-size: .78rem; }
.day .dot { width: 6px; height: 6px; margin-top: 2px; }
.day.on { background: var(--med-surface); }
.day:focus-visible { outline: 2px solid var(--med-blue); }

.detail { margin: 8px 12px 0; padding: 10px 12px; border-radius: 12px; background: var(--med-surface); border: 1px solid var(--med-line); }
.detail-h { display: flex; align-items: center; gap: 8px; font-size: .8rem; color: var(--med-muted); }
.tag { padding: 1px 8px; border-radius: 999px; font-size: .72rem; font-weight: 700; color: #0f1724; }
.tag.t-blue { background: var(--t-blue); color: #fff; } .tag.t-white { background: var(--t-white); } .tag.t-red { background: var(--t-red); color: #fff; }
.detail-v { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 4px; font-size: .9rem; }
.sep { width: 1px; height: 12px; background: var(--med-line); }
.detail-p { font-size: .78rem; color: var(--med-muted); margin-top: 4px; }
.warn { color: var(--t-red); font-style: normal; font-weight: 600; }

.power { margin: 10px 12px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--med-line); }
.power.is-over { border-color: var(--t-red); }
.power-t { display: flex; justify-content: space-between; font-size: .85rem; }
.gauge { height: 6px; border-radius: 6px; background: var(--med-line); margin: 8px 0 6px; overflow: hidden; }
.gauge i { display: block; height: 100%; background: linear-gradient(90deg, var(--med-green), var(--med-blue)); }
.is-over .gauge i { background: var(--t-red); }
.power-n { font-size: .75rem; color: var(--med-muted); }

.eco { margin: 10px 12px 0; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--med-line); font-size: .82rem; display: flex; align-items: center; gap: 8px; }
.eco.e-ok .dot { background: var(--med-down); }
.eco.e-warn { border-color: #f0a33a; } .eco.e-warn .dot { background: #f0a33a; }
.eco.e-alert { border-color: var(--t-red); } .eco.e-alert .dot { background: var(--t-red); }
.eco-l { color: var(--med-muted); }
footer { padding: 10px 18px 14px; font-size: .7rem; color: var(--med-muted); }
.empty { padding: 18px; display: flex; flex-direction: column; gap: 6px; font-size: .9rem; }
.empty span { color: var(--med-muted); }
/* Thème Home Assistant : fond, textes et bordures suivent le thème clair ou sombre */
ha-card.th-ha {
  --med-bg: var(--ha-card-background, var(--card-background-color, #fff));
  --med-surface: color-mix(in srgb, var(--primary-text-color, #000) 5%, transparent);
  --med-line: var(--divider-color, rgba(127, 127, 127, .25));
  --med-text: var(--primary-text-color, #1f2937);
  --med-muted: var(--secondary-text-color, #6b7280);
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
}
ha-card.th-ha.light { --med-green: #4c8a0b; --med-up: #c2560f; --med-down: #1d8a4b; }
/* Style MyElectricalData en version claire (theme: auto quand Home Assistant est en mode clair) */
ha-card.th-v2.light {
  --med-bg: #ffffff; --med-surface: #f2f5f9; --med-line: #dbe2ec;
  --med-text: #1a2434; --med-muted: #5b6b82;
  --med-green: #4c8a0b; --med-blue: #1673b8; --med-up: #c2560f; --med-down: #1d8a4b;
  box-shadow: 0 1px 3px rgba(26, 36, 52, .08);
}
ha-card.light .k-hc { color: #2f5fb8; }
ha-card.light .k-hp { color: #b35619; }
ha-card.light .t-white .dot, ha-card.light .tag.t-white { box-shadow: inset 0 0 0 1px #aab3c0; }
ha-card.light .chart rect.sel { fill: rgba(0, 0, 0, .05); }
ha-card.light .tag.t-white { color: #1f2937; }
@media (max-width: 420px) { .hero-v { font-size: 2rem; } .tempo { width: 100%; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>`;

/* ----------------------------------------------------------------- éditeurs */

const THEME_SELECT = {
  name: "theme",
  selector: {
    select: {
      mode: "dropdown",
      options: [
        { value: "v2", label: "Style MyElectricalData (bleu nuit)" },
        { value: "auto", label: "Style MyElectricalData, clair ou sombre selon Home Assistant" },
        { value: "ha", label: "Thème Home Assistant (clair ou sombre)" },
      ],
    },
  },
};

/** Éditeur visuel : formulaire Home Assistant construit à partir du schéma. */
function makeEditor(schemaOf, labels, defaults) {
  // schéma fixe, ou fonction de la configuration (champs du contrat choisi)
  const schemaFn = typeof schemaOf === "function" ? schemaOf : () => schemaOf;
  const hasDays = schemaFn({}).some((s) => s.name === "days");
  return class extends HTMLElement {
    setConfig(config) {
      this._config = { ...config };
      this._draw();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._form) this._form.hass = hass;
      else this._draw();
    }

    _draw() {
      if (!this._hass || !this._config) return;
      if (!this._form) {
        this._form = document.createElement("ha-form");
        this._form.computeLabel = (s) => labels[s.name] || s.name;
        this._form.addEventListener("value-changed", (ev) => {
          const v = { ...ev.detail.value };
          if (hasDays && v.days !== undefined) v.days = Number(v.days);
          const changedSchema = v.contract !== this._config.contract;
          this._config = v;
          this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: v }, bubbles: true, composed: true }));
          if (changedSchema) this._draw();
        });
        this.appendChild(this._form);
      }
      this._form.hass = this._hass;
      this._form.schema = schemaFn({ ...defaults, ...this._config });
      this._form.data = hasDays
        ? { ...defaults, ...this._config, days: String(this._config.days || defaults.days) }
        : { ...defaults, ...this._config };
    }
  };
}

const LINKYPUISSANCECARD_FIELDS = [
  { name: "title", selector: { text: {} } },
  { name: "contract", selector: { select: { mode: "dropdown", options: [{ value: "tempo", label: "Tempo" }, { value: "hchp", label: "Heures creuses / heures pleines" }, { value: "base", label: "Base" }] } } },
  { name: "power", selector: { entity: { domain: "sensor" } } },
  { name: "power_active", selector: { entity: { domain: "sensor" } } },
  { name: "subscribed", selector: { entity: { domain: "sensor" } } },
  { name: "subscribed_kva", selector: { number: { min: 3, max: 36, step: 3, mode: "box", unit_of_measurement: "kVA" } } },
  { name: "tarif", selector: { entity: { domain: "sensor" } } },
  { name: "price_hc", selector: { text: {} } },
  { name: "price_hp", selector: { text: {} } },
  { name: "price_base", selector: { text: {} } },
  { name: "price", selector: { entity: { domain: "sensor" } } },
  { name: "cost_rate", selector: { entity: { domain: "sensor" } } },
  { name: "overrun", selector: { entity: { domain: "binary_sensor" } } },
  { name: "overruns_day", selector: { entity: { domain: "sensor" } } },
  { name: "show_peak", selector: { boolean: {} } },
  THEME_SELECT,
];
// Puissance : prix HC et HP en option HC/HP, prix Base en option Base
const LINKYPUISSANCECARD_SCHEMA = (cfg) => {
  const k = CONTRACTS[cfg?.contract] ? cfg.contract : "tempo";
  const hide = k === "tempo" ? ["price_hc", "price_hp", "price_base"] : k === "hchp" ? ["price_base"] : ["price_hc", "price_hp"];
  return LINKYPUISSANCECARD_FIELDS.filter((f) => !hide.includes(f.name));
};
const LinkyPuissanceCardEditor = makeEditor(LINKYPUISSANCECARD_SCHEMA, { title: "Titre", power: "Puissance apparente instantanée en VA (PAPP, SINSTS) : jauge face à la puissance souscrite", power_active: "Puissance active en W (facultatif) : coût en € réel et cos φ", subscribed: "Puissance souscrite : capteur en kVA, ou ISOUSC en ampères (mode historique)", subscribed_kva: "Puissance souscrite saisie (kVA), si aucun capteur ne la donne", contract: "Contrat", tarif: "Période tarifaire en cours : poste Tempo (« HP BLEU ») ou PTEC (« HC.. »), trouvée seule sinon", price_hc: "Prix du kWh en heures creuses, TTC (nombre ou entité)", price_hp: "Prix du kWh en heures pleines, TTC (nombre ou entité)", price_base: "Prix du kWh en option Base, TTC (nombre ou entité)", price: "Prix du kWh en cours (capteur), utilisé si aucun prix n'est saisi ci-dessus", cost_rate: "Coût instantané (€/h)", overrun: "Dépassement de puissance (binary_sensor)", overruns_day: "Nombre de dépassements du jour", show_peak: "Afficher le pic du jour (statistiques HA)", theme: "Couleurs de la carte" }, LinkyPuissanceCard.DEFAULTS);
const LINKYFACTURECARD_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "cycle_start", selector: { text: {} } },
  { name: "cost_cycle", selector: { entity: { domain: "sensor" } } },
  { name: "energy_cycle", selector: { entity: { domain: "sensor" } } },
  { name: "cost_month", selector: { entity: { domain: "sensor" } } },
  { name: "energy_month", selector: { entity: { domain: "sensor" } } },
  { name: "cost_day", selector: { entity: { domain: "sensor" } } },
  { name: "estimate_month", selector: { entity: { domain: "sensor" } } },
  { name: "subscription_month", selector: { entity: {} } },
  { name: "kwh_cycle", selector: { entity: { domain: "sensor" } } },
  { name: "kwh_prev_cycle", selector: { entity: { domain: "sensor" } } },
  { name: "kwh_month", selector: { entity: { domain: "sensor" } } },
  { name: "kwh_day", selector: { entity: { domain: "sensor" } } },
  { name: "budget_month", selector: { number: { min: 0, max: 1000, step: 1, mode: "box", unit_of_measurement: "€" } } },
  THEME_SELECT,
];
const LinkyFactureCardEditor = makeEditor(LINKYFACTURECARD_SCHEMA, { title: "Titre", cycle_start: "Début du cycle de facturation (MM-JJ, ex. 10-01)", cost_cycle: "Coût total du cycle (abonnement compris)", energy_cycle: "Coût énergie du cycle", cost_month: "Coût total du mois", energy_month: "Coût énergie du mois", cost_day: "Coût total aujourd’hui", estimate_month: "Estimation du mois", subscription_month: "Abonnement mensuel", kwh_cycle: "Énergie du cycle (kWh)", kwh_prev_cycle: "Énergie du cycle précédent (kWh)", kwh_month: "Énergie du mois (kWh)", kwh_day: "Énergie aujourd’hui (kWh)", budget_month: "Budget mensuel (facultatif)", theme: "Couleurs de la carte" }, LinkyFactureCard.DEFAULTS);
const TEMPO_ONLY = ["prefix", "suffix_day", "suffix_month", "suffix_cycle", "price_prefix", "source_prefix", "fallback_prefix", "current"];
/** Champs de l'éditeur selon le contrat : Tempo (préfixes des capteurs) ou HC/HP et Base (prix saisis). */
const byContract = (list) => (cfg) => {
  const k = CONTRACTS[cfg?.contract] ? cfg.contract : "tempo";
  return list.filter((f) => (k === "tempo" ? !["price_hc", "price_hp", "price_base", "energy_prefix"].includes(f.name)
    : !TEMPO_ONLY.includes(f.name) && !(k === "hchp" && f.name === "price_base") && !(k === "base" && ["price_hc", "price_hp"].includes(f.name))));
};
const LINKYTEMPOPOSTESCARD_FIELDS = [
  { name: "title", selector: { text: {} } },
  { name: "contract", selector: { select: { mode: "dropdown", options: [{ value: "tempo", label: "Tempo" }, { value: "hchp", label: "Heures creuses / heures pleines" }, { value: "base", label: "Base" }] } } },
  { name: "energy_prefix", selector: { text: {} } },
  { name: "price_hc", selector: { text: {} } },
  { name: "price_hp", selector: { text: {} } },
  { name: "price_base", selector: { text: {} } },
  { name: "period", selector: { select: { mode: "dropdown", options: [{ value: "jour", label: "Aujourd'hui" }, { value: "hier", label: "Hier (HC/HP, Base)" }, { value: "semaine", label: "Semaine (HC/HP, Base)" }, { value: "mois", label: "Ce mois" }, { value: "annee", label: "Cette année (HC/HP, Base)" }, { value: "cycle", label: "Cycle (Tempo)" }] } } },
  { name: "prefix", selector: { text: {} } },
  { name: "suffix_day", selector: { text: {} } },
  { name: "suffix_month", selector: { text: {} } },
  { name: "suffix_cycle", selector: { text: {} } },
  { name: "price_prefix", selector: { text: {} } },
  { name: "source_prefix", selector: { text: {} } },
  { name: "tarif", selector: { entity: { domain: "sensor" } } },
  THEME_SELECT,
];
// HC/HP et Base : section dépliable pour choisir ses propres capteurs de consommation, période par période
const energyEntitiesSection = (cfg) => {
  const k = CONTRACTS[cfg?.contract] ? cfg.contract : "tempo";
  if (k === "tempo") return [];
  const postes = k === "hchp" ? ["hc", "hp"] : ["base"];
  return [{ type: "expandable", name: "energy_entities", title: "Mes capteurs de consommation (kWh)", flatten: true,
    schema: MED_PERIODS.flatMap((per) => postes.map((pk) => ({ name: `energy_${pk}_${per.key}`, selector: { entity: { domain: "sensor" } } }))) }];
};
const LINKYTEMPOPOSTESCARD_SCHEMA = (cfg) => {
  const list = byContract(LINKYTEMPOPOSTESCARD_FIELDS)(cfg);
  const i = list.findIndex((f) => f.name === "energy_prefix");
  return i < 0 ? list : [...list.slice(0, i + 1), ...energyEntitiesSection(cfg), ...list.slice(i + 1)];
};
const ENERGY_ENTITY_LABELS = Object.fromEntries(MED_PERIODS.flatMap((per) => [["hc", "Heures creuses"], ["hp", "Heures pleines"], ["base", "Base"]]
  .map(([pk, l]) => [`energy_${pk}_${per.key}`, `${l} : ${per.label.toLowerCase()}`])));
const LinkyTempoPostesCardEditor = makeEditor(LINKYTEMPOPOSTESCARD_SCHEMA, { ...ENERGY_ENTITY_LABELS, energy_entities: "Mes capteurs de consommation (kWh)", title: "Titre", contract: "Contrat", energy_prefix: "Préfixe de l'export MyElectricalData (vide = trouvé seul ; inutile avec vos propres capteurs ci-dessous)", price_hc: "Prix du kWh en heures creuses, TTC (nombre ou entité)", price_hp: "Prix du kWh en heures pleines, TTC (nombre ou entité)", price_base: "Prix du kWh en option Base, TTC (nombre ou entité)", period: "Onglet ouvert au chargement", prefix: "Préfixe des capteurs d’énergie", suffix_day: "Suffixe du jour", suffix_month: "Suffixe du mois", suffix_cycle: "Suffixe du cycle", price_prefix: "Préfixe des capteurs de prix", source_prefix: "Préfixe des prix MyElectricalData, si les prix ci-dessus n’existent pas (<blue|white|red>_<hc|hp>)", tarif: "Période tarifaire en cours (Tempo ou PTEC HC / HP), trouvée seule sinon", theme: "Couleurs de la carte" }, LinkyTempoPostesCard.DEFAULTS);
const LINKYTEMPOPRIXCARD_FIELDS = [
  { name: "title", selector: { text: {} } },
  { name: "contract", selector: { select: { mode: "dropdown", options: [{ value: "tempo", label: "Tempo" }, { value: "hchp", label: "Heures creuses / heures pleines" }, { value: "base", label: "Base" }] } } },
  { name: "price_hc", selector: { text: {} } },
  { name: "price_hp", selector: { text: {} } },
  { name: "price_base", selector: { text: {} } },
  { name: "price_prefix", selector: { text: {} } },
  { name: "source_prefix", selector: { text: {} } },
  { name: "fallback_prefix", selector: { text: {} } },
  { name: "current", selector: { entity: { domain: "sensor" } } },
  { name: "tarif", selector: { entity: { domain: "sensor" } } },
  THEME_SELECT,
];
const LINKYTEMPOPRIXCARD_SCHEMA = byContract(LINKYTEMPOPRIXCARD_FIELDS);
const LinkyTempoPrixCardEditor = makeEditor(LINKYTEMPOPRIXCARD_SCHEMA, { title: "Titre", contract: "Contrat", price_hc: "Prix du kWh en heures creuses, TTC (nombre ou entité)", price_hp: "Prix du kWh en heures pleines, TTC (nombre ou entité)", price_base: "Prix du kWh en option Base, TTC (nombre ou entité)", price_prefix: "Préfixe des prix utilisés (<couleur>_<hc|hp>)", source_prefix: "Préfixe des prix MyElectricalData (<blue|white|red>_<hc|hp>)", fallback_prefix: "Préfixe des prix de secours", current: "Prix du kWh en cours", tarif: "Période tarifaire en cours (Tempo ou PTEC HC / HP), trouvée seule sinon", theme: "Couleurs de la carte" }, LinkyTempoPrixCard.DEFAULTS);
const LINKYCARBONECARD_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "intensity", selector: { entity: { domain: "sensor" } } },
  { name: "fossil", selector: { entity: { domain: "sensor" } } },
  { name: "energy_today", selector: { entity: { domain: "sensor" } } },
  { name: "hours", selector: { number: { min: 6, max: 168, step: 1, mode: "box", unit_of_measurement: "h" } } },
  THEME_SELECT,
];
const LinkyCarboneCardEditor = makeEditor(LINKYCARBONECARD_SCHEMA, { title: "Titre", intensity: "Intensité carbone (gCO₂eq/kWh), trouvée seule", fossil: "Part d'énergies fossiles du réseau (%), trouvée seule", energy_today: "Consommation de la maison aujourd'hui (kWh), pour son CO₂ (facultatif)", hours: "Heures affichées dans la courbe", theme: "Couleurs de la carte" }, LinkyCarboneCard.DEFAULTS);
const LINKYCYCLECARD_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "control", selector: { entity: { domain: "sensor" } } },
  { name: "baseline_prefix", selector: { text: {} } },
  { name: "cycle_prefix", selector: { text: {} } },
  { name: "cycle_suffix", selector: { text: {} } },
  { name: "total", selector: { entity: { domain: "sensor" } } },
  { name: "archive", selector: { entity: {} } },
  { name: "scripts", selector: { entity: { domain: "script", multiple: true } } },
  { name: "automations", selector: { entity: { domain: "automation", multiple: true } } },
  { name: "cycle_start", selector: { text: {} } },
  { name: "month_prefix", selector: { text: {} } },
  { name: "month_suffix", selector: { text: {} } },
  THEME_SELECT,
];
const LinkyCycleCardEditor = makeEditor(LINKYCYCLECARD_SCHEMA, { title: "Titre", control: "Contrôle des compteurs actifs", baseline_prefix: "Préfixe des baselines", cycle_prefix: "Préfixe des compteurs du cycle", cycle_suffix: "Suffixe des compteurs du cycle", total: "Énergie totale du cycle", archive: "Archive du cycle précédent", scripts: "Scripts proposés en boutons", automations: "Automatisations surveillées", cycle_start: "Début du cycle (MM-JJ), pour comparer au mois", month_prefix: "Préfixe des compteurs du mois", month_suffix: "Suffixe des compteurs du mois", theme: "Couleurs de la carte" }, LinkyCycleCard.DEFAULTS);

const LINKYENEDISSTATUSCARD_SCHEMA = [
  { name: "title", selector: { text: {} } },
  { name: "prefix", selector: { text: {} } },
  { name: "show_roles", selector: { boolean: {} } },
  { name: "show_link", selector: { boolean: {} } },
  THEME_SELECT,
];
const LinkyEnedisStatusCardEditor = makeEditor(LINKYENEDISSTATUSCARD_SCHEMA, { title: "Titre", prefix: "Préfixe des capteurs Scrape (ex. sensor.enedis_datahub_)", show_roles: "Afficher le rôle de chaque service", show_link: "Lien vers la page Enedis DataHub", theme: "Couleurs de la carte" }, LinkyEnedisStatusCard.DEFAULTS);

/* ---------------------------------------------------------- enregistrement */

if (typeof customElements !== "undefined") {
  const define = (name, cls) => { if (!customElements.get(name)) customElements.define(name, cls); };
  window.customCards = window.customCards || [];
  const card = (type, name, description) => {
    if (!window.customCards.some((c) => c.type === type)) window.customCards.push({ type, name, description, preview: true });
  };
  define("linky-puissance-card", LinkyPuissanceCard);
  define("linky-puissance-card-editor", LinkyPuissanceCardEditor);
  card("linky-puissance-card", "Carte Linky Puissance", "Puissance appelée en direct sur la puissance souscrite, coût en ce moment, pic et dépassements du jour.");
  define("linky-facture-card", LinkyFactureCard);
  define("linky-facture-card-editor", LinkyFactureCardEditor);
  card("linky-facture-card", "Carte Linky Facture", "Coût du cycle de facturation, projection, mois en cours, estimation et comparaison avec le cycle précédent.");
  define("linky-tempo-postes-card", LinkyTempoPostesCard);
  define("linky-tempo-postes-card-editor", LinkyTempoPostesCardEditor);
  card("linky-tempo-postes-card", "Carte Linky Tempo par poste", "Énergie et coût des 6 postes Tempo (Bleu, Blanc, Rouge × HC/HP) pour aujourd'hui, le mois et le cycle.");
  define("linky-tempo-prix-card", LinkyTempoPrixCard);
  define("linky-tempo-prix-card-editor", LinkyTempoPrixCardEditor);
  card("linky-tempo-prix-card", "Carte Linky Prix Tempo", "Prix TTC des 6 postes Tempo, poste en cours et vérification de la source (MyElectricalData ou valeur de secours).");
  define("linky-cycle-card", LinkyCycleCard);
  define("linky-cycle-card-editor", LinkyCycleCardEditor);
  card("linky-cycle-card", "Carte Linky Contrôle du cycle", "Baselines des compteurs Tempo, automatisations du cycle et scripts de maintenance (confirmation en 2 clics).");
  define("linky-enedis-status-card", LinkyEnedisStatusCard);
  define("linky-carbone-card", LinkyCarboneCard);
  define("linky-carbone-card-editor", LinkyCarboneCardEditor);
  card("linky-carbone-card", "Carte Intensité carbone", "Intensité carbone et part fossile de l'électricité du réseau (Electricity Maps), meilleur moment, courbe et CO₂ de la maison.");
  define("linky-enedis-status-card-editor", LinkyEnedisStatusCardEditor);
  card("linky-enedis-status-card", "Carte État des services Enedis", "État des API Enedis DataHub (Data Connect) : incident en cours, service par service, heure du dernier changement, lien vers la page officielle.");
  console.info(`%c LINKY-ENERGIE-CARDS %c ${CARD_VERSION} `, "background:#96d21f;color:#1a2434;font-weight:700", "background:#1d93e3;color:#fff");
}
})();
