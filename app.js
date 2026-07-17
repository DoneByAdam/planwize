/* MaxOut — 401(k) Contribution Planner
   Static app: works fully offline/guest via localStorage.
   Optional Supabase backend for accounts + sync (see README.md). */
"use strict";

/* ============================================================
   CONFIG — paste your Supabase project values to enable accounts.
   Leave blank and the app runs in device-only mode.
   ============================================================ */
const SUPABASE_URL = "";      // e.g. "https://abcd1234.supabase.co"
const SUPABASE_ANON_KEY = ""; // the "anon public" key (safe to ship; RLS protects data)

/* ============================================================
   IRS DATA — fetched from irs-limits.json, with embedded fallback
   ============================================================ */
const IRS_FALLBACK = {
  years: {
    "2026": {
      deferralLimit402g: 24500, catchUp50: 8000, catchUp60to63: 11250,
      totalAdditions415c: 72000, compLimit401a17: 360000,
      ssWageBase: 184500, ssRate: 0.062, medicareRate: 0.0145,
      addlMedicareRate: 0.009, addlMedicareThreshold: 200000,
      rothCatchUpWageThreshold: 150000,
      standardDeduction: { single: 16100, mfj: 32200 },
      brackets: {
        single: [[0,.10],[12400,.12],[50400,.22],[105700,.24],[201775,.32],[256225,.35],[640600,.37]],
        mfj:    [[0,.10],[24800,.12],[100800,.22],[211400,.24],[403550,.32],[512450,.35],[768700,.37]]
      }
    }
  }
};
let IRS = IRS_FALLBACK;

/* ============================================================
   STATE
   ============================================================ */
const DEFAULT_STATE = {
  planYear: 2026, filing: "single", birthYear: 1988,
  firstPay: "2026-01-09", bonusPct: 15, bonusPeriod: 6,
  salaryTiers: [{ start: 1, salary: 174441 }, { start: 4, salary: 186402 }],
  rateTiers: [{ start: 1, pre: 12, roth: 0, after: 0 }],
  matchRate: 50, matchCap: 8, trueUp: "no",
  balance: 150000, retireAge: 60, expReturn: 7, contribGrowth: 2,
  scenarios: [
    { name: "Current plan", pre: 12, roth: 0, after: 0 },
    { name: "Max exactly", pre: 11.5, roth: 0, after: 0 },
    { name: "Roth split", pre: 6, roth: 6, after: 0 },
    { name: "Mega backdoor", pre: 11.5, roth: 0, after: 10 }
  ]
};
let state = load() || structuredClone(DEFAULT_STATE);
let results = null;
let charts = {};
let supa = null, session = null, encKeyPass = null;

/* ============================================================
   ENGINE  (ported 1:1 from the verified Excel model)
   ============================================================ */
function limitsFor(year) {
  const ys = IRS.years || {};
  if (ys[year]) return { ...ys[year], _year: String(year) };
  const latest = Object.keys(ys).sort().pop();
  return { ...ys[latest], _year: latest + " (latest available)" };
}
function age(s) { return s.planYear - s.birthYear; }
function myLimit(s, L) {
  const a = age(s);
  return L.deferralLimit402g + (a >= 60 && a <= 63 ? L.catchUp60to63 : a >= 50 ? L.catchUp50 : 0);
}
function tierAt(tiers, p, key) {
  let v = tiers[0][key];
  for (const t of tiers) if (p >= t.start) v = t[key];
  return v;
}
function fedTax(taxable, brackets) {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [lo, r] = brackets[i];
    const hi = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    if (taxable > lo) tax += (Math.min(taxable, hi) - lo) * r;
  }
  return tax;
}
function marginalRate(taxable, brackets) {
  let r = brackets[0][1];
  for (const [lo, rate] of brackets) if (taxable > lo) r = rate;
  return r;
}

function compute(s) {
  const L = limitsFor(s.planYear);
  const lim = myLimit(s, L);
  const brackets = L.brackets[s.filing];
  const stdDed = L.standardDeduction[s.filing];
  const salaryTiers = [...s.salaryTiers].sort((a, b) => a.start - b.start);
  const rateTiers = [...s.rateTiers].sort((a, b) => a.start - b.start);
  const bonusSalary = tierAt(salaryTiers, s.bonusPeriod, "salary");
  const bonus = (s.bonusPct / 100) * bonusSalary;

  const rows = [];
  let grossYTD = 0, defYTD = 0, matchTotal = 0, ssTotal = 0, medTotal = 0;
  let preTotal = 0, rothTotal = 0, afterTotal = 0, cappedAt = null, ssStopsAt = null;
  const first = new Date(s.firstPay + "T12:00:00");

  for (let p = 1; p <= 26; p++) {
    const date = new Date(first); date.setDate(first.getDate() + (p - 1) * 14);
    const base = tierAt(salaryTiers, p, "salary") / 26;
    const bon = p === s.bonusPeriod ? bonus : 0;
    const g = base + bon;
    const pre = tierAt(rateTiers, p, "pre") / 100;
    const roth = tierAt(rateTiers, p, "roth") / 100;
    const after = tierAt(rateTiers, p, "after") / 100;
    const desired = (pre + roth) * g;
    const room = Math.max(0, lim - defYTD);
    const allowed = Math.min(desired, room);
    const preD = desired > 0 ? allowed * pre / (pre + roth) : 0;
    const rothD = desired > 0 ? allowed * roth / (pre + roth) : 0;
    if (desired > allowed + 1e-9 && cappedAt === null) cappedAt = p;
    const afterD = after * g;
    const match = (s.matchRate / 100) * Math.min(preD + rothD, (s.matchCap / 100) * g);
    const ss = L.ssRate * Math.max(0, Math.min(g, L.ssWageBase - grossYTD));
    const med = L.medicareRate * g + L.addlMedicareRate * Math.max(0, Math.min(g, grossYTD + g - L.addlMedicareThreshold));
    grossYTD += g;
    if (ssStopsAt === null && grossYTD >= L.ssWageBase) ssStopsAt = p;
    defYTD += preD + rothD;
    preTotal += preD; rothTotal += rothD; afterTotal += afterD;
    matchTotal += match; ssTotal += ss; medTotal += med;
    rows.push({ p, date, g, bon, pre, roth, preD, rothD, afterD, defYTD, room: lim - defYTD, match, ss, med });
  }

  if (s.trueUp === "yes") {
    matchTotal = (s.matchRate / 100) * Math.min(defYTD, (s.matchCap / 100) * grossYTD);
  }

  const taxable = Math.max(0, grossYTD - preTotal - stdDed);
  const tax = fedTax(taxable, brackets);
  const taxable0 = Math.max(0, grossYTD - stdDed);
  const tax0 = fedTax(taxable0, brackets);
  const effRate = taxable > 0 ? tax / taxable : 0;
  for (const r of rows) {
    r.takeHome = r.g - r.preD - r.rothD - r.afterD - r.ss - r.med - (r.g - r.preD) * effRate;
  }

  // projection
  const proj = [];
  let bal = +s.balance || 0;
  const c0 = defYTD + afterTotal + matchTotal;
  let totalContrib = 0;
  const a0 = age(s);
  for (let i = 0; i <= Math.max(1, 72 - a0); i++) {
    const a = a0 + i;
    const c = a <= s.retireAge ? c0 * Math.pow(1 + s.contribGrowth / 100, i) : 0;
    const growth = (bal + c) * (s.expReturn / 100);
    bal = bal + c + growth;
    totalContrib += c;
    proj.push({ year: +s.planYear + i, age: a, contrib: c, balance: bal });
    if (a >= Math.max(s.retireAge + 8, 70)) break;
  }
  const atRet = proj.find(r => r.age === +s.retireAge)?.balance ?? bal;

  return {
    L, lim, rows, bonus, grossYTD, preTotal, rothTotal, afterTotal, defTotal: defYTD,
    matchTotal, ssTotal, medTotal, cappedAt, ssStopsAt,
    taxable, tax, tax0, taxSaved: tax0 - tax, effRate,
    marginal: marginalRate(taxable, brackets), stdDed,
    additions: defYTD + afterTotal + matchTotal,
    maxRate: lim / grossYTD, proj, atRet, totalContrib,
    maxMatch: (s.matchRate / 100) * (s.matchCap / 100) * grossYTD
  };
}

function computeScenario(s, R, sc) {
  const L = R.L, lim = R.lim, comp = R.grossYTD;
  const rate = (sc.pre + sc.roth) / 100;
  const desired = rate * comp;
  const actual = Math.min(desired, lim);
  const capped = desired > lim;
  const periods = capped ? Math.min(26, Math.ceil(lim / (rate * comp / 26))) : 26;
  const afterD = (sc.after / 100) * comp;
  let match = (s.matchRate / 100) * Math.min(rate, s.matchCap / 100) * (comp / 26) * periods;
  if (s.trueUp === "yes") match = (s.matchRate / 100) * Math.min(actual, (s.matchCap / 100) * comp);
  const matchLost = Math.max(0, R.maxMatch - match);
  const preD = rate > 0 ? actual * (sc.pre / 100) / rate : 0;
  const taxable = Math.max(0, comp - preD - R.stdDed);
  const tax = fedTax(taxable, L.brackets[s.filing]);
  const fica = L.ssRate * Math.min(comp, L.ssWageBase) + L.medicareRate * comp
             + L.addlMedicareRate * Math.max(0, comp - L.addlMedicareThreshold);
  const takeHome = comp - actual - afterD - tax - fica;
  return { ...sc, desired, actual, capped, periods, afterD, match, matchLost,
           additions: actual + afterD + match, over415: actual + afterD + match > L.totalAdditions415c,
           taxSaved: R.tax0 - tax, takeHome, perPay: takeHome / 26 };
}

/* ============================================================
   FORMATTING + DOM HELPERS
   ============================================================ */
const $ = id => document.getElementById(id);
const money = n => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = n => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n * 100).toFixed(n * 100 % 1 ? 2 : 0) + "%";
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); }

/* ============================================================
   INSIGHTS ENGINE — rules with reputable sources
   ============================================================ */
function buildInsights(s, R) {
  const out = [];
  const a = age(s);
  const effMatchNeeded = s.matchCap;
  const currentRate = tierAt([...s.rateTiers].sort((x,y)=>x.start-y.start), 26, "pre")
                    + tierAt([...s.rateTiers].sort((x,y)=>x.start-y.start), 26, "roth");

  if (currentRate < effMatchNeeded) {
    out.push({ kind: "warn", t: "You're leaving free money on the table",
      p: `Your contribution rate (${currentRate}%) is below the ${effMatchNeeded}% needed to capture the full employer match. Capturing the entire match is the single highest-return move in retirement saving — it's an instant ${s.matchRate}% return.`,
      src: "Fidelity Viewpoints & Vanguard 'How America Saves' — max the match first." });
  } else {
    out.push({ kind: "good", t: "Full employer match captured",
      p: `You contribute at least ${effMatchNeeded}% every pay period, so you earn the entire ${money(R.maxMatch)} match available this year.`,
      src: "Fidelity Viewpoints — capture the full match before anything else." });
  }

  if (R.cappedAt && R.cappedAt < 26 && s.trueUp !== "yes") {
    const lost = Math.max(0, R.maxMatch - R.matchTotal);
    if (lost > 1) out.push({ kind: "warn", t: `Front-loading is costing you ${money(lost)} of match`,
      p: `You hit the ${money(R.lim)} limit in pay period ${R.cappedAt}. Paychecks after that get no match unless your plan trues up. Dial the rate to ${pct(R.maxRate)} to fill the limit on your final paycheck instead — same contribution, more match.`,
      src: "Standard per-payroll match mechanics; confirm true-up in your plan's Summary Plan Description." });
  }

  const savingsRate = (R.defTotal + R.afterTotal + R.matchTotal) / R.grossYTD;
  if (savingsRate < 0.15) {
    out.push({ kind: "info", t: `Total savings rate: ${pct(savingsRate)} — Fidelity's guideline is 15%`,
      p: `Fidelity's rule of thumb is saving 15% of pre-tax income annually (including employer match) starting at 25 to retire comfortably at 67. You're at ${pct(savingsRate)}; each extra 1% is about ${money(R.grossYTD * 0.01 / 26)} per paycheck.`,
      src: "Fidelity Viewpoints — 'How much should I save for retirement?' (15% guideline)." });
  } else {
    out.push({ kind: "good", t: `Savings rate ${pct(savingsRate)} — above the 15% guideline`,
      p: `Including your employer match, you're saving above Fidelity's 15% benchmark. Nice position to be in.`,
      src: "Fidelity Viewpoints — 15% savings-rate guideline." });
  }

  const milestones = [[30,1],[35,2],[40,3],[45,4],[50,6],[55,7],[60,8],[67,10]];
  let target = null;
  for (const [ma, mult] of milestones) if (a >= ma) target = mult;
  if (target !== null) {
    const salary = tierAt([...s.salaryTiers].sort((x,y)=>x.start-y.start), 26, "salary");
    const ratio = s.balance / salary;
    if (ratio >= target) out.push({ kind: "good", t: `On track: ${ratio.toFixed(1)}× salary saved (milestone: ${target}×)`,
      p: `Fidelity's age-based milestones suggest ${target}× your salary by age ${a}. You're at ${ratio.toFixed(1)}×.`,
      src: "Fidelity's savings milestones (1× by 30 … 10× by 67)." });
    else out.push({ kind: "info", t: `Milestone check: ${ratio.toFixed(1)}× salary saved vs. ${target}× suggested`,
      p: `Fidelity suggests ~${target}× salary by your age. Milestones are direction, not destiny — your planned ${money(R.additions)}/yr closes the gap with compounding on its side.`,
      src: "Fidelity's savings milestones (1× by 30 … 10× by 67)." });
  }

  if (R.marginal >= 0.24 && R.rothTotal > R.preTotal) {
    out.push({ kind: "info", t: "In the " + pct(R.marginal) + " bracket, pre-tax dollars work hard",
      p: `Every pre-tax dollar avoids ${pct(R.marginal)} federal tax today. Roth wins if you expect a higher rate in retirement; many savers in the 24%+ brackets lean pre-tax now and diversify with Roth in lower-income years.`,
      src: "Fidelity & Schwab guidance on traditional-vs-Roth by marginal bracket." });
  }

  if (a >= 50) {
    const wages = R.grossYTD;
    const mustRoth = wages > R.L.rothCatchUpWageThreshold;
    out.push({ kind: "info", t: "Catch-up contributions unlocked",
      p: `At ${a}, you can defer an extra ${money(a>=60&&a<=63?R.L.catchUp60to63:R.L.catchUp50)} this year.${mustRoth ? " Because your prior-year wages exceed " + money(R.L.rothCatchUpWageThreshold) + ", SECURE 2.0 requires catch-up contributions to be Roth starting 2026." : ""}`,
      src: "IRS COLA notice; SECURE 2.0 Act §603." });
  } else if (a >= 45) {
    out.push({ kind: "info", t: `Catch-up contributions start at 50`,
      p: `In ${50 - a} years you can add ${money(R.L.catchUp50)}+ on top of the regular limit — worth building into your long-range plan.`,
      src: "IRS retirement topics — catch-up contributions." });
  }

  if (R.afterTotal > 0) {
    out.push({ kind: "info", t: "After-tax contributions: convert them",
      p: `Your ${money(R.afterTotal)} of after-tax contributions only shine if converted to Roth (the "mega backdoor"). Left unconverted, their earnings are taxed as ordinary income. Check that your plan allows in-plan Roth conversion or in-service withdrawal.`,
      src: "Fidelity — 'Mega backdoor Roth' explainer; IRC §415(c)." });
  }

  if (R.ssStopsAt) {
    out.push({ kind: "good", t: `Paycheck raise incoming: Social Security tax stops at pay #${R.ssStopsAt}`,
      p: `Your income crosses the ${money(R.L.ssWageBase)} wage base, so the 6.2% SS tax drops off — roughly ${money2(R.rows[0].g * R.L.ssRate)} more per paycheck for the rest of the year. A painless moment to raise your contribution rate.`,
      src: "SSA contribution & benefit base." });
  }

  out.push({ kind: "info", t: "Don't forget the HSA (if eligible)",
    p: "If you're on a high-deductible health plan, the HSA is triple tax-advantaged (deductible in, tax-free growth, tax-free out for medical) — many experts fund it right after the 401(k) match.",
    src: "Fidelity & Morningstar guidance on savings order: match → HSA → max 401(k)." });
  return out;
}

/* ============================================================
   RENDER
   ============================================================ */
function renderAll() {
  results = compute(state);
  const R = results, s = state;
  $("brandYear").textContent = s.planYear;
  $("dashYear").textContent = s.planYear;

  // pay strip
  const strip = $("paystrip"); strip.innerHTML = "";
  for (const r of R.rows) {
    const cell = document.createElement("div");
    const contributing = r.preD + r.rothD > 0.005;
    const full = (r.pre + r.roth) * r.g;
    const partial = contributing && r.preD + r.rothD < full - 0.01;
    cell.className = "cell" + (partial ? " partial" : "") + (r.bon > 0 ? " bonus" : "") + (R.ssStopsAt === r.p ? " ss-stop" : "");
    cell.tabIndex = 0;
    cell.dataset.tip = `Pay #${r.p} · ${r.date.toLocaleDateString("en-US",{month:"short",day:"numeric"})}\nGross ${money2(r.g)}\n401(k) ${money2(r.preD + r.rothD)}${r.bon ? "\nBonus " + money(r.bon) : ""}`;
    const fill = document.createElement("div"); fill.className = "fill";
    fill.style.height = contributing ? Math.max(14, Math.min(100, (r.preD + r.rothD) / full * 100)) + "%" : "0";
    cell.appendChild(fill); strip.appendChild(cell);
  }

  // stats
  $("stLimit").textContent = money(R.lim);
  $("stLimitNote").textContent = `402(g)${myLimit(s,R.L)>R.L.deferralLimit402g?" + catch-up":""} · IRS ${R.L._year}`;
  $("stDeferral").textContent = money(R.defTotal);
  const room = R.lim - R.defTotal;
  $("stDeferralNote").innerHTML = room < 1 ? `<span class="pill good">Maxed out</span>` :
    `<span class="pill warn">${money(room)} of room unused</span>`;
  $("stMatch").textContent = money(R.matchTotal);
  const lost = Math.max(0, R.maxMatch - R.matchTotal);
  $("stMatchNote").innerHTML = lost > 1 ? `<span class="pill bad">${money(lost)} match lost</span>` : `<span class="pill good">Full match captured</span>`;
  $("stTaxSaved").textContent = money(R.taxSaved);
  $("stMaxRate").textContent = pct(R.maxRate);
  $("stBalance").textContent = money(R.atRet);
  $("stBalanceNote").textContent = `at age ${s.retireAge}, ${s.expReturn}% return`;

  // insights
  $("insights").innerHTML = buildInsights(s, R).map(i =>
    `<div class="insight ${i.kind}"><div><div class="t">${i.t}</div><p>${i.p}</p><div class="src">Source: ${i.src}</div></div></div>`).join("");

  renderPayTable(R);
  renderScenarios();
  renderProjection(R);
  renderIRS(R);
}

function renderPayTable(R) {
  const h = ["Pay #","Date","Gross","Pre-tax","Roth","After-tax","Deferral YTD","Room left","Match","SS tax","Medicare","Take-home"];
  let html = "<thead><tr>" + h.map(x => `<th>${x}</th>`).join("") + "</tr></thead><tbody>";
  for (const r of R.rows) {
    const capRow = R.cappedAt === r.p;
    html += `<tr${capRow ? ' class="capped"' : ""}><td>${r.p}${r.bon ? " ●" : ""}</td>
      <td>${r.date.toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td>
      <td>${money2(r.g)}</td><td>${money2(r.preD)}</td><td>${money2(r.rothD)}</td><td>${money2(r.afterD)}</td>
      <td>${money(r.defYTD)}</td><td>${money(Math.max(0,r.room))}</td><td>${money2(r.match)}</td>
      <td>${money2(r.ss)}</td><td>${money2(r.med)}</td><td>${money2(r.takeHome)}</td></tr>`;
  }
  html += `</tbody><tfoot><tr><td colspan="2">Totals</td><td>${money(R.grossYTD)}</td><td>${money(R.preTotal)}</td>
    <td>${money(R.rothTotal)}</td><td>${money(R.afterTotal)}</td><td>${money(R.defTotal)}</td><td>—</td>
    <td>${money(R.matchTotal)}</td><td>${money(R.ssTotal)}</td><td>${money(R.medTotal)}</td><td>—</td></tr></tfoot>`;
  $("payTable").innerHTML = html;
}

function renderScenarios() {
  const R = results, s = state;
  const computed = s.scenarios.map(sc => computeScenario(s, R, sc));
  const best = computed.reduce((b, c, i) =>
    (c.matchLost < 1 && c.takeHome > computed[b].takeHome) ? i : b, 0);
  const row = $("scnRow"); row.innerHTML = "";
  computed.forEach((c, i) => {
    const div = document.createElement("div");
    div.className = "scn" + (i === best && computed[best].matchLost < 1 ? " best" : "");
    div.innerHTML = `<h3>${c.name}</h3>
      <div class="rates">
        <div class="field"><label>Pre-tax %</label><input type="number" step="0.5" value="${c.pre}" data-i="${i}" data-k="pre"></div>
        <div class="field"><label>Roth %</label><input type="number" step="0.5" value="${c.roth}" data-i="${i}" data-k="roth"></div>
        <div class="field"><label>After %</label><input type="number" step="0.5" value="${c.after}" data-i="${i}" data-k="after"></div>
      </div>
      <dl>
        <div><dt>401(k) deferral</dt><dd>${money(c.actual)}${c.capped ? ' <span class="pill warn">caps pay ' + c.periods + "</span>" : ""}</dd></div>
        <div><dt>Employer match</dt><dd>${money(c.match)}</dd></div>
        <div><dt>Match lost</dt><dd class="${c.matchLost > 1 ? "bad" : "good"}">${money(c.matchLost)}</dd></div>
        <div><dt>After-tax in</dt><dd>${money(c.afterD)}</dd></div>
        <div><dt>Total additions</dt><dd>${money(c.additions)}${c.over415 ? ' <span class="pill bad">over 415(c)</span>' : ""}</dd></div>
        <div><dt>Federal tax saved</dt><dd class="good">${money(c.taxSaved)}</dd></div>
        <div><dt>Take-home / paycheck</dt><dd>${money2(c.perPay)}</dd></div>
      </dl>`;
    row.appendChild(div);
  });
  row.querySelectorAll("input").forEach(inp => inp.addEventListener("change", e => {
    const { i, k } = e.target.dataset;
    state.scenarios[i][k] = +e.target.value || 0;
    persist(); renderScenarios();
  }));

  if (charts.scn) charts.scn.destroy();
  charts.scn = new Chart($("scnChart"), {
    type: "bar",
    data: { labels: computed.map(c => c.name),
      datasets: [
        { label: "Take-home", data: computed.map(c => c.takeHome), backgroundColor: "#0e7c5b" },
        { label: "Retirement dollars (deferral+after-tax+match)", data: computed.map(c => c.additions), backgroundColor: "#13273d" },
        { label: "Federal tax saved", data: computed.map(c => c.taxSaved), backgroundColor: "#b9770e" }
      ] },
    options: { responsive: true, plugins: { legend: { position: "bottom" } },
      scales: { y: { ticks: { callback: v => "$" + (v/1000) + "k" } } } }
  });
}

function renderProjection(R) {
  $("prjSub").textContent = `Starting from ${money(+state.balance||0)}, contributing ${money(R.additions)} in year one (growing ${state.contribGrowth}%/yr), at ${state.expReturn}% annual return.`;
  $("prjBalance").textContent = money(R.atRet);
  $("prjIncome").textContent = money(R.atRet * 0.04);
  $("prjContrib").textContent = money(R.totalContrib);
  if (charts.prj) charts.prj.destroy();
  charts.prj = new Chart($("prjChart"), {
    type: "line",
    data: { labels: R.proj.map(r => r.age),
      datasets: [{ label: "Balance", data: R.proj.map(r => r.balance),
        borderColor: "#0e7c5b", backgroundColor: "rgba(14,124,91,.12)", fill: true, tension: .25, pointRadius: 0 }] },
    options: { responsive: true, plugins: { legend: { display: false },
        tooltip: { callbacks: { title: it => "Age " + it[0].label, label: it => money(it.raw) } } },
      scales: { y: { ticks: { callback: v => "$" + (v/1e6).toFixed(1) + "M" } },
        x: { title: { display: true, text: "Age" } } } }
  });
}

function renderIRS(R) {
  const L = R.L;
  $("irsYearLabel").textContent = L._year;
  $("irsReadout").innerHTML = [
    ["Employee deferral limit — 402(g)", money(L.deferralLimit402g)],
    ["Catch-up (50+) / enhanced (60–63)", money(L.catchUp50) + " / " + money(L.catchUp60to63)],
    ["Total additions — 415(c)", money(L.totalAdditions415c)],
    ["Social Security wage base", money(L.ssWageBase)],
    ["Standard deduction (" + state.filing + ")", money(L.standardDeduction[state.filing])]
  ].map(([k, v]) => `${k}: <strong>${v}</strong>`).join("<br>");
  $("irsSource").textContent = "Loaded automatically from irs-limits.json. Values follow the IRS annual COLA notice and SSA wage-base announcement; the file is versioned so one yearly update reaches every user.";
}

/* ============================================================
   INPUT BINDING
   ============================================================ */
function bindInputs() {
  const simple = { planYear: "planYear", filing: "filing", birthYear: "birthYear",
    firstPay: "firstPay", bonusPct: "bonusPct", bonusPeriod: "bonusPeriod",
    matchRate: "matchRate", matchCap: "matchCap", trueUp: "trueUp",
    balance: "balance", retireAge: "retireAge", expReturn: "expReturn", contribGrowth: "contribGrowth" };
  const yearSel = $("planYear");
  Object.keys(IRS.years).sort().forEach(y => {
    const o = document.createElement("option"); o.value = y; o.textContent = y; yearSel.appendChild(o);
  });
  for (const [id, key] of Object.entries(simple)) {
    const el = $(id);
    el.value = state[key];
    el.addEventListener("change", () => {
      state[key] = el.type === "number" || id === "planYear" ? +el.value : el.value;
      afterEdit();
    });
  }
  drawTierTables();
  $("addSalary").onclick = () => { state.salaryTiers.push({ start: 1, salary: 0 }); drawTierTables(); };
  $("addRate").onclick = () => { state.rateTiers.push({ start: 1, pre: 0, roth: 0, after: 0 }); drawTierTables(); };
}
function drawTierTables() {
  const st = $("salaryTable").querySelector("tbody"); st.innerHTML = "";
  state.salaryTiers.forEach((t, i) => {
    st.insertAdjacentHTML("beforeend",
      `<tr><td><input type="number" min="1" max="26" value="${t.start}" data-i="${i}" data-k="start" data-t="salary"></td>
       <td><input type="number" value="${t.salary}" data-i="${i}" data-k="salary" data-t="salary"></td>
       <td>${i > 0 ? `<button class="rowbtn" data-del-salary="${i}" aria-label="Remove">×</button>` : ""}</td></tr>`);
  });
  const rt = $("rateTable").querySelector("tbody"); rt.innerHTML = "";
  state.rateTiers.forEach((t, i) => {
    rt.insertAdjacentHTML("beforeend",
      `<tr><td><input type="number" min="1" max="26" value="${t.start}" data-i="${i}" data-k="start" data-t="rate"></td>
       <td><input type="number" step="0.5" value="${t.pre}" data-i="${i}" data-k="pre" data-t="rate"></td>
       <td><input type="number" step="0.5" value="${t.roth}" data-i="${i}" data-k="roth" data-t="rate"></td>
       <td><input type="number" step="0.5" value="${t.after}" data-i="${i}" data-k="after" data-t="rate"></td>
       <td>${i > 0 ? `<button class="rowbtn" data-del-rate="${i}" aria-label="Remove">×</button>` : ""}</td></tr>`);
  });
  document.querySelectorAll("#salaryTable input,#rateTable input").forEach(inp =>
    inp.addEventListener("change", e => {
      const { i, k, t } = e.target.dataset;
      (t === "salary" ? state.salaryTiers : state.rateTiers)[i][k] = +e.target.value || 0;
      afterEdit();
    }));
  document.querySelectorAll("[data-del-salary]").forEach(b => b.onclick = () => { state.salaryTiers.splice(+b.dataset.delSalary, 1); drawTierTables(); afterEdit(); });
  document.querySelectorAll("[data-del-rate]").forEach(b => b.onclick = () => { state.rateTiers.splice(+b.dataset.delRate, 1); drawTierTables(); afterEdit(); });
}
function afterEdit() { persist(); renderAll(); }

/* ============================================================
   PERSISTENCE — localStorage always; Supabase when signed in
   ============================================================ */
function load() { try { return JSON.parse(localStorage.getItem("maxout.plan")); } catch { return null; } }
let saveTimer = null;
function persist() {
  localStorage.setItem("maxout.plan", JSON.stringify(state));
  if (session) { clearTimeout(saveTimer); saveTimer = setTimeout(cloudSave, 900); }
}

/* ---------- client-side encryption (AES-256-GCM, PBKDF2 210k) ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
async function deriveKey(pass, salt) {
  const km = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptJSON(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
  const blob = new Uint8Array(salt.length + iv.length + ct.length);
  blob.set(salt); blob.set(iv, 16); blob.set(ct, 28);
  return btoa(String.fromCharCode(...blob));
}
async function decryptJSON(b64, pass) {
  const blob = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const key = await deriveKey(pass, blob.slice(0, 16));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(16, 28) }, key, blob.slice(28));
  return JSON.parse(dec.decode(pt));
}

async function cloudSave() {
  if (!supa || !session) return;
  try {
    const row = { user_id: session.user.id, name: "My plan" };
    if (encKeyPass) { row.is_encrypted = true; row.ciphertext = await encryptJSON(state, encKeyPass); row.data = null; }
    else { row.is_encrypted = false; row.data = state; row.ciphertext = null; }
    const { error } = await supa.from("plans").upsert(row, { onConflict: "user_id" });
    if (error) throw error;
    $("syncDot").classList.add("on");
  } catch (e) { console.error(e); toast("Cloud save failed — data is still safe on this device"); }
}
async function cloudLoad() {
  const { data, error } = await supa.from("plans").select("*").maybeSingle();
  if (error || !data) return null;
  if (data.is_encrypted) {
    for (let tries = 0; tries < 3; tries++) {
      const pass = prompt("Enter your encryption passphrase to unlock your plan:");
      if (pass === null) return null;
      try { const obj = await decryptJSON(data.ciphertext, pass); encKeyPass = pass; return obj; }
      catch { alert("That passphrase didn't unlock the data. Try again."); }
    }
    return null;
  }
  return data.data;
}

/* ============================================================
   AUTH UI
   ============================================================ */
let authMode = "signin";
function setupAuth() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) {
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supa.auth.getSession().then(({ data }) => { session = data.session; refreshAuthUI(); if (session) syncDown(); });
    supa.auth.onAuthStateChange((_e, s2) => { session = s2; refreshAuthUI(); });
  } else refreshAuthUI();

  $("authBtn").onclick = () => {
    if (session) { supa.auth.signOut(); encKeyPass = null; toast("Signed out — device-only mode"); }
    else openAuth("signin");
  };
  $("bannerSignup").onclick = () => openAuth("signup");
  $("tabSignin").onclick = () => setAuthMode("signin");
  $("tabSignup").onclick = () => setAuthMode("signup");
  document.querySelector("#authModal [data-close]").onclick = () => $("authModal").classList.remove("open");
  $("authModal").addEventListener("click", e => { if (e.target.id === "authModal") $("authModal").classList.remove("open"); });

  $("authSubmit").onclick = async () => {
    const email = $("authEmail").value.trim(), pass = $("authPass").value;
    const notice = $("authNotice"); notice.hidden = true;
    if (!supa) {
      notice.hidden = false;
      notice.innerHTML = "Accounts aren't configured yet. The owner needs to add Supabase keys at the top of <code>app.js</code> — see README.md. Your data still saves on this device.";
      return;
    }
    try {
      $("authSubmit").disabled = true;
      const fn = authMode === "signup"
        ? supa.auth.signUp({ email, password: pass })
        : supa.auth.signInWithPassword({ email, password: pass });
      const { error } = await fn;
      if (error) throw error;
      encKeyPass = $("encPass").value || null;
      $("authModal").classList.remove("open");
      if (authMode === "signup") { await cloudSave(); toast("Account created — your plan is saved to it"); }
      else {
        const cloud = await cloudLoad();
        if (cloud) { state = cloud; localStorage.setItem("maxout.plan", JSON.stringify(state)); location.reload(); }
        else { await cloudSave(); toast("Signed in — plan synced"); }
      }
      refreshAuthUI();
    } catch (e) {
      notice.hidden = false; notice.textContent = e.message || "Sign-in failed. Check email and password.";
    } finally { $("authSubmit").disabled = false; }
  };
}
async function syncDown() {
  const cloud = await cloudLoad();
  if (cloud) { state = cloud; localStorage.setItem("maxout.plan", JSON.stringify(state)); renderAllSafe(); }
}
function openAuth(mode) { setAuthMode(mode); $("authModal").classList.add("open"); }
function setAuthMode(m) {
  authMode = m;
  $("tabSignin").classList.toggle("active", m === "signin");
  $("tabSignup").classList.toggle("active", m === "signup");
  $("authSubmit").textContent = m === "signin" ? "Sign in" : "Create account";
  $("encFieldWrap").style.display = m === "signup" ? "" : "none";
}
function refreshAuthUI() {
  $("authBtnLabel").textContent = session ? "Sign out" : "Sign in";
  $("syncDot").classList.toggle("on", !!session);
  $("guestBanner").hidden = !!session;
}

/* ============================================================
   PDF REPORT
   ============================================================ */
function makePDF() {
  const R = results, s = state;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const G = [14, 124, 91], INK = [15, 29, 46];
  doc.setFillColor(...INK); doc.rect(0, 0, 210, 30, "F");
  doc.setTextColor(255).setFont("helvetica", "bold").setFontSize(18);
  doc.text(`MaxOut — ${s.planYear} 401(k) Contribution Plan`, 14, 13);
  doc.setFontSize(9).setFont("helvetica", "normal");
  doc.text(`Generated ${new Date().toLocaleDateString()} · Filing: ${s.filing === "single" ? "Single" : "Married filing jointly"} · Age ${age(s)}`, 14, 21);

  doc.setTextColor(...INK).setFontSize(12).setFont("helvetica", "bold");
  doc.text("Plan summary", 14, 40);
  doc.autoTable({
    startY: 44, theme: "grid", styles: { fontSize: 9 }, headStyles: { fillColor: INK },
    head: [["Metric", "Value"]],
    body: [
      ["Your IRS deferral limit", money(R.lim)],
      ["Planned employee deferral (pre-tax + Roth)", money(R.defTotal)],
      ["Room remaining", money(Math.max(0, R.lim - R.defTotal))],
      ["After-tax contributions", money(R.afterTotal)],
      ["Employer match", money(R.matchTotal) + (R.maxMatch - R.matchTotal > 1 ? `  (${money(R.maxMatch - R.matchTotal)} lost to front-loading)` : "")],
      ["Total annual additions (415(c) limit " + money(R.L.totalAdditions415c) + ")", money(R.additions)],
      ["Federal marginal / effective rate", pct(R.marginal) + " / " + pct(R.effRate)],
      ["Federal tax saved by pre-tax deferrals", money(R.taxSaved)],
      ["Rate that maxes the limit exactly", pct(R.maxRate)],
      ["Social Security tax stops", R.ssStopsAt ? "Pay #" + R.ssStopsAt : "Not reached"],
      ["Projected balance at age " + s.retireAge, money(R.atRet)],
      ["Est. retirement income (4% rule)", money(R.atRet * 0.04)]
    ]
  });

  doc.setFontSize(12).setFont("helvetica", "bold");
  doc.text("Coaching notes", 14, doc.lastAutoTable.finalY + 10);
  doc.autoTable({
    startY: doc.lastAutoTable.finalY + 14, theme: "striped", styles: { fontSize: 8.5, cellPadding: 2.5 },
    headStyles: { fillColor: G }, head: [["Insight", "Detail"]],
    body: buildInsights(s, R).map(i => [i.t, i.p + "  (" + i.src + ")"]),
    columnStyles: { 0: { cellWidth: 55, fontStyle: "bold" } }
  });

  doc.addPage();
  doc.setFontSize(12).setFont("helvetica", "bold").setTextColor(...INK);
  doc.text("Paycheck schedule", 14, 16);
  doc.autoTable({
    startY: 20, theme: "grid", styles: { fontSize: 7.5, halign: "right" },
    headStyles: { fillColor: INK }, columnStyles: { 0: { halign: "left" }, 1: { halign: "left" } },
    head: [["#", "Date", "Gross", "Pre-tax", "Roth", "After-tax", "YTD", "Match", "SS", "Medicare", "Take-home"]],
    body: R.rows.map(r => [r.p, r.date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      money2(r.g), money2(r.preD), money2(r.rothD), money2(r.afterD), money(r.defYTD),
      money2(r.match), money2(r.ss), money2(r.med), money2(r.takeHome)]),
    foot: [["", "Totals", money(R.grossYTD), money(R.preTotal), money(R.rothTotal), money(R.afterTotal),
      money(R.defTotal), money(R.matchTotal), money(R.ssTotal), money(R.medTotal), ""]],
    footStyles: { fillColor: G }
  });
  doc.setFontSize(7).setTextColor(120);
  doc.text("Estimates for planning only — not tax or investment advice. Verify IRS figures at irs.gov and plan rules in your Summary Plan Description.", 14, 290);
  doc.save(`MaxOut_${s.planYear}_plan.pdf`);
  toast("Report downloaded");
}

/* ============================================================
   NAV + BOOT
   ============================================================ */
function renderAllSafe() { try { renderAll(); } catch (e) { console.error(e); toast("Something went wrong rendering — check inputs"); } }
document.querySelectorAll(".nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".nav button").forEach(x => x.classList.toggle("active", x === b));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + b.dataset.view));
  window.scrollTo({ top: 0 });
});
$("reportBtn").onclick = makePDF;

(async function boot() {
  try {
    const r = await fetch("irs-limits.json", { cache: "no-store" });
    if (r.ok) IRS = await r.json();
  } catch { /* offline — fallback stays */ }
  if (!load()) $("guestBanner").hidden = false; else $("guestBanner").hidden = false;
  bindInputs();
  setupAuth();
  renderAllSafe();
})();
