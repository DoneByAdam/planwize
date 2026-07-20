/* Planwize — Smart Retirement Planning · 401(k) Contribution Planner
   Static app: works fully offline/guest via localStorage.
   Optional Supabase backend for accounts + sync (see README.md). */
"use strict";

const APP_VERSION = "11.0";

/* ============================================================
   CONFIG — paste your Supabase project values to enable accounts.
   Leave blank and the app runs in device-only mode.
   ============================================================ */
const SUPABASE_URL = "https://diedbpcowqnvvapfgutv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpZWRicGNvd3FudnZhcGZndXR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0MDIzMjQsImV4cCI6MjA5OTk3ODMyNH0.OpqjouG5K8ooLYlk0AbmbeLShnCV33439u86bciAslE";

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
let STATES = { approx: true, states: {} };   // populated from state-taxes.json

/* ============================================================
   PAY FREQUENCIES
   ============================================================ */
const FREQ = {
  weekly:      { n: 52, label: "weekly",            stepDays: 7  },
  biweekly:    { n: 26, label: "every two weeks",   stepDays: 14 },
  semimonthly: { n: 24, label: "on the 1st & 15th", stepDays: null },
  monthly:     { n: 12, label: "monthly",           stepDays: null }
};
function payDates(s) {
  const f = FREQ[s.frequency] || FREQ.biweekly;
  const dates = [];
  if (f.stepDays) {
    const first = new Date(s.firstPay + "T12:00:00");
    for (let i = 0; i < f.n; i++) { const d = new Date(first); d.setDate(first.getDate() + i * f.stepDays); dates.push(d); }
  } else if (s.frequency === "semimonthly") {
    for (let m = 0; m < 12; m++) { dates.push(new Date(s.planYear, m, 1, 12)); dates.push(new Date(s.planYear, m, 15, 12)); }
  } else { // monthly — 1st of each month
    for (let m = 0; m < 12; m++) dates.push(new Date(s.planYear, m, 1, 12));
  }
  return dates;
}

/* ============================================================
   STATE — simple, generic example numbers (edit everything!)
   ============================================================ */
const DEFAULT_STATE = {
  calculated: false,
  planYear: 2026, filing: "single", birthYear: 1990,
  state: "", localRate: 0,
  frequency: "biweekly", firstPay: "2026-01-09",
  bonusPct: 0, bonusAmt: 0, bonusActual: 0, bonusPeriod: 6,
  salaryTiers: [{ start: 1, salary: 85000 }],
  rateTiers: [{ start: 1, pre: 6, roth: 0, after: 0 }],
  matchRate: 50, matchCap: 6, trueUp: "no",
  employerBasePct: 0, employerBasePeriod: 3,
  balance: 25000, retireAge: 65, expReturn: 7, contribGrowth: 2,
  scenarios: [
    { name: "My current plan", pre: 6, roth: 0, after: 0 },
    { name: "Capture full match", pre: 6, roth: 0, after: 0 },
    { name: "Save 10%", pre: 10, roth: 0, after: 0 },
    { name: "Roth split", pre: 5, roth: 5, after: 0 }
  ]
};
let plans = [];          // [{id, name, created, updated, data}]
let currentPlanId = null;
let state = loadStore();
let results = null;
let charts = {};
let supa = null, session = null, encKeyPass = null;

/* ============================================================
   ENGINE
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


function stateData(s) { return (STATES.states || {})[s.state] || null; }
function stateBrackets(sd, filing) {
  if (filing === "mfj") {
    if (sd.mfj) return sd.mfj;
    if (sd.mfjDouble) return sd.brackets.map(([f, r]) => [f * 2, r]);
  }
  return sd.brackets;
}
/* preTax is the pre-tax 401(k) amount; states flagged taxes401k give it no deduction */
function stateTaxCalc(s, comp, preTax) {
  const sd = stateData(s);
  if (!sd || sd.type === "none") return { tax: 0, local: 0, sd };
  const ded = (sd.stdDeduction && sd.stdDeduction[s.filing]) || 0;
  const base = Math.max(0, comp - (sd.taxes401k ? 0 : preTax) - ded);
  let tax = 0;
  if (sd.type === "flat") tax = base * sd.rate / 100;
  else {
    const br = stateBrackets(sd, s.filing);
    for (let i = 0; i < br.length; i++) {
      const [lo, r] = br[i];
      const hi = i + 1 < br.length ? br[i + 1][0] : Infinity;
      if (base > lo) tax += (Math.min(base, hi) - lo) * r / 100;
    }
  }
  const local = (sd.localTaxes ? Math.max(0, +s.localRate || 0) : 0) / 100 * base;
  return { tax, local, sd };
}

function compute(s) {
  const L = limitsFor(s.planYear);
  const N = (FREQ[s.frequency] || FREQ.biweekly).n;
  const lim = myLimit(s, L);
  const brackets = L.brackets[s.filing];
  const stdDed = L.standardDeduction[s.filing];
  const salaryTiers = [...s.salaryTiers].sort((a, b) => a.start - b.start);
  const rateTiers = [...s.rateTiers].sort((a, b) => a.start - b.start);
  const bonusP = Math.min(Math.max(1, +s.bonusPeriod || 1), N);
  const bonusTarget = +s.bonusAmt > 0 ? +s.bonusAmt : (s.bonusPct / 100) * tierAt(salaryTiers, bonusP, "salary");
  const bonus = +s.bonusActual > 0 ? +s.bonusActual : bonusTarget;
  const dates = payDates(s);

  const rows = [];
  let grossYTD = 0, defYTD = 0, matchTotal = 0, neTotal = 0, ssTotal = 0, medTotal = 0;
  let preTotal = 0, rothTotal = 0, afterTotal = 0, cappedAt = null, ssStopsAt = null;

  for (let p = 1; p <= N; p++) {
    const base = tierAt(salaryTiers, p, "salary") / N;
    const bon = (p === bonusP && bonus > 0) ? bonus : 0;
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
    const neP = Math.min(Math.max(1, +s.employerBasePeriod || 1), N);
    const ne = (p === neP && +s.employerBasePct > 0)
      ? (s.employerBasePct / 100) * tierAt(salaryTiers, p, "salary") : 0;
    const ss = L.ssRate * Math.max(0, Math.min(g, L.ssWageBase - grossYTD));
    const med = L.medicareRate * g + L.addlMedicareRate * Math.max(0, Math.min(g, grossYTD + g - L.addlMedicareThreshold));
    grossYTD += g;
    if (ssStopsAt === null && grossYTD >= L.ssWageBase) ssStopsAt = p;
    defYTD += preD + rothD;
    preTotal += preD; rothTotal += rothD; afterTotal += afterD;
    matchTotal += match; neTotal += ne; ssTotal += ss; medTotal += med;
    rows.push({ p, date: dates[p - 1], g, bon, pre, roth, preD, rothD, afterD, defYTD, room: lim - defYTD, match, ne, ss, med });
  }

  if (s.trueUp === "yes") {
    matchTotal = (s.matchRate / 100) * Math.min(defYTD, (s.matchCap / 100) * grossYTD);
  }

  const taxable = Math.max(0, grossYTD - preTotal - stdDed);
  const tax = fedTax(taxable, brackets);
  const taxable0 = Math.max(0, grossYTD - stdDed);
  const tax0 = fedTax(taxable0, brackets);
  const st = stateTaxCalc(s, grossYTD, preTotal);
  const st0 = stateTaxCalc(s, grossYTD, 0);
  const stateTax = st.tax, localTax = st.local;
  const stateSaved = (st0.tax + st0.local) - (st.tax + st.local);
  const effRate = taxable > 0 ? (tax + stateTax + localTax) / taxable : 0;
  for (const r of rows) {
    r.takeHome = r.g - r.preD - r.rothD - r.afterD - r.ss - r.med - (r.g - r.preD) * effRate;
  }

  const proj = [];
  let bal = +s.balance || 0;
  const c0 = defYTD + afterTotal + matchTotal + neTotal;
  let totalContrib = 0;
  const a0 = age(s);
  for (let i = 0; i <= Math.max(1, 72 - a0); i++) {
    const a = a0 + i;
    const c = a <= s.retireAge ? c0 * Math.pow(1 + s.contribGrowth / 100, i) : 0;
    const growth = (bal + c) * (s.expReturn / 100);
    bal = bal + c + growth;
    totalContrib += c;
    proj.push({ year: +s.planYear + i, age: a, contrib: c, balance: bal });
    if (a >= Math.max(+s.retireAge + 8, 70)) break;
  }
  const atRet = proj.find(r => r.age === +s.retireAge)?.balance ?? bal;

  return {
    L, N, lim, rows, bonus, grossYTD, preTotal, rothTotal, afterTotal, defTotal: defYTD,
    matchTotal, neTotal, ssTotal, medTotal, cappedAt, ssStopsAt, bonusTarget, bonusIsActual: +s.bonusActual > 0,
    taxable, tax, tax0, taxSaved: tax0 - tax, effRate,
    stateTax, localTax, stateSaved, stateInfo: st.sd,
    marginal: marginalRate(taxable, brackets), stdDed,
    additions: defYTD + afterTotal + matchTotal + neTotal,
    maxRate: lim / grossYTD, proj, atRet, totalContrib,
    maxMatch: (s.matchRate / 100) * (s.matchCap / 100) * grossYTD
  };
}

function computeScenario(s, R, sc) {
  const L = R.L, lim = R.lim, comp = R.grossYTD, N = R.N;
  const rate = (sc.pre + sc.roth) / 100;
  const desired = rate * comp;
  const actual = Math.min(desired, lim);
  const capped = desired > lim;
  const periods = capped ? Math.min(N, Math.ceil(lim / (rate * comp / N))) : N;
  const afterD = (sc.after / 100) * comp;
  let match = (s.matchRate / 100) * Math.min(rate, s.matchCap / 100) * (comp / N) * periods;
  if (s.trueUp === "yes") match = (s.matchRate / 100) * Math.min(actual, (s.matchCap / 100) * comp);
  const matchLost = Math.max(0, R.maxMatch - match);
  const preD = rate > 0 ? actual * (sc.pre / 100) / rate : 0;
  const taxable = Math.max(0, comp - preD - R.stdDed);
  const tax = fedTax(taxable, L.brackets[s.filing]);
  const fica = L.ssRate * Math.min(comp, L.ssWageBase) + L.medicareRate * comp
             + L.addlMedicareRate * Math.max(0, comp - L.addlMedicareThreshold);
  const stc = stateTaxCalc(s, comp, preD);
  const stc0 = stateTaxCalc(s, comp, 0);
  const stTax = stc.tax + stc.local;
  const stSaved = (stc0.tax + stc0.local) - stTax;
  const takeHome = comp - actual - afterD - tax - stTax - fica;
  const additions = actual + afterD + match + R.neTotal;
  return { ...sc, desired, actual, capped, periods, afterD, match, matchLost,
           additions, over415: additions > L.totalAdditions415c,
           taxSaved: R.tax0 - tax, stTax, stSaved, takeHome, perPay: takeHome / N };
}

/* ============================================================
   GLOSSARY — beginner-friendly, opened from any "?" button
   ============================================================ */
const GLOSSARY = {
  whatIsThis: { t: "What is this tool?", b: `Planwize plans your <strong>401(k)</strong> — the retirement account you fund straight from your paycheck, usually with free matching money from your employer.<br><br>You tell it how you're paid and what % you contribute; it shows the IRS limits, taxes, and what it all compounds into by retirement.<div class="ex">Rule one of retirement saving: <strong>never leave employer match on the table.</strong> It's an instant 25–100% return.</div>` },
  payStrip: { t: "Reading this chart", b: `Each bar is one paycheck of the year, in order. The <strong style="color:var(--mint)">green fill</strong> shows how much of that check goes into your 401(k).<br><br>An <strong style="color:var(--amber)">amber bar</strong> means you hit the annual IRS limit mid-paycheck — contributions stop there. A <strong style="color:var(--red)">red edge</strong> marks the paycheck where Social Security tax stops for the year (see "Why paychecks grow late in the year").` },
  limit402g: { t: "The IRS limit — 402(g)", b: `Each year the IRS caps how much <strong>you</strong> can put into a 401(k) from your salary (pre-tax + Roth combined). For 2026 it's <strong>$24,500</strong>, and it usually rises a little every year.<br><br>Age 50+? You get extra "catch-up" room. Employer match does <strong>not</strong> count against this limit — it has its own, much higher ceiling (the 415(c) limit).` },
  deferral: { t: "Deferral", b: `"Deferral" is just the formal word for <strong>the money you send from your paycheck into your 401(k)</strong>. You're deferring pay until retirement.<br><br>It comes in two flavors — pre-tax and Roth — and the IRS annual limit applies to the two combined.` },
  match: { t: "Employer match — free money", b: `Most employers add money when you contribute. A typical formula: <strong>"50% of the first 6% of pay"</strong> — for every dollar you put in (up to 6% of your salary), they add 50 cents.<div class="ex">On an $85,000 salary, a 50%-of-6% match is worth <strong>$2,550/year</strong> — but only if you contribute at least 6%. Contribute 3% and you only get half of it.</div>Financial advisors agree on almost nothing, except this: capture the full match before any other savings goal.` },
  trueUp: { t: "The true-up (and the front-loading trap)", b: `Most plans calculate your match <strong>each paycheck</strong>. If you rush to the IRS limit by September, your October–December paychecks contribute $0 — and earn $0 match.<br><br>A <strong>true-up</strong> is a year-end correction some plans make, paying you the match you would have earned. Check your plan's Summary Plan Description or ask HR: "Do we have a match true-up?"<div class="ex">No true-up? Spread contributions so you hit the limit on the <em>last</em> paycheck. The dashboard shows the exact rate.</div>` },
  preVsRoth: { t: "Pre-tax vs. Roth in one minute", b: `<strong>Pre-tax:</strong> skip taxes now, pay them when you withdraw in retirement. Lowers this year's tax bill.<br><br><strong>Roth:</strong> pay taxes now, then withdrawals in retirement are 100% tax-free — growth included.<br><br>Rule of thumb: high tax bracket today → pre-tax tends to win. Early career / lower bracket → Roth tends to win. Unsure? Splitting between both is a respectable hedge.` },
  megaBackdoor: { t: "After-tax & the mega backdoor Roth", b: `Some plans allow a third bucket: <strong>after-tax contributions</strong> — beyond the normal IRS limit, up to the much larger "total additions" ceiling ($72,000 in 2026, counting everything).<br><br>On their own they're mediocre. The trick — nicknamed the <strong>mega backdoor Roth</strong> — is immediately converting them to Roth inside the plan, so all future growth becomes tax-free.<div class="ex">Requires your plan to allow both after-tax contributions <em>and</em> in-plan Roth conversion. Ask HR — it's a hidden superpower for big savers.</div>` },
  catchup: { t: "Catch-up contributions (50+)", b: `The year you turn 50, the IRS lets you contribute <strong>extra</strong> beyond the normal limit — $8,000 more in 2026. Ages 60–63 get an even bigger boost ($11,250).<br><br>One 2026 wrinkle: if you earned over $150,000 the prior year, catch-up money must go in as <strong>Roth</strong> (SECURE 2.0 law).` },
  ssWageBase: { t: "Why paychecks grow late in the year", b: `Social Security tax (6.2%) only applies to the first <strong>$184,500</strong> you earn in 2026. Cross that line and the tax simply stops — your take-home jumps for the rest of the year.<br><br>The red-edged bar on the dashboard marks that paycheck.<div class="ex">Painless move: when SS tax stops, raise your 401(k) rate by ~6% — your take-home stays the same, your retirement gets the difference.</div>` },
  taxSaved: { t: "How pre-tax saves you taxes", b: `Every pre-tax dollar you contribute is a dollar the IRS doesn't tax this year. In the 22% bracket, contributing $5,000 pre-tax cuts your federal tax bill by about <strong>$1,100</strong>.<br><br>This number compares your actual plan against contributing $0 — it's the discount the tax code gives you for saving.` },
  maxRate: { t: "The 'max exactly' rate", b: `This is the contribution rate that fills your IRS limit on the <strong>final paycheck</strong> of the year — the sweet spot.<br><br>Why not max faster? If your plan matches per-paycheck without a true-up, finishing early means later paychecks earn no match. Slow and steady literally pays more.` },
  compounding: { t: "Compounding — the eighth wonder", b: `Your money earns returns; those returns earn returns. At 7%/year, money <strong>doubles roughly every 10 years</strong> — so a dollar invested at 30 can be ~$10 at 65.<br><br>That's why starting early and capturing the match beat almost any clever strategy later.` },
  fourPct: { t: "The 4% rule", b: `A classic planning shortcut: in retirement you can withdraw about <strong>4% of your balance per year</strong> (adjusting for inflation) with a low historical chance of running out over 30 years.<br><br>Flip it around: want $60,000/year from savings? Aim for ~$1.5 million. It's a rough compass, not a guarantee.` },
  nonElective: { t: "Automatic employer contributions", b: `Some employers put money into your retirement account <strong>whether or not you contribute anything</strong> — often called a <em>non-elective</em>, <em>core</em>, or <em>base</em> contribution. Example: "the company contributes 3% of salary each year."<br><br>It's separate from the match, doesn't count against <em>your</em> IRS deferral limit, but does count toward the overall 415(c) ceiling.<div class="ex">Check your plan documents or ask HR: "Do we get a non-elective or core contribution, and when is it deposited?" It's often early in the year, based on last year's salary.</div>` },
  multiPlan: { t: "Plans: what-ifs, jobs, and history", b: `Each plan is a complete snapshot — inputs plus a name and timestamps.<br><br><strong>What-if runs:</strong> duplicate your plan and change one thing ("2026 — aggressive Roth").<br><strong>Multiple jobs:</strong> make a plan per job — but remember the IRS deferral limit is <strong>per person, not per job</strong>. Two 401(k)s still share one ${"$"}24,500 limit; keep an eye on the combined total yourself.<br><strong>History:</strong> keep last year's plan around — over time your plans become a record of how your saving evolved.` },
  stateTax: { t: "State income taxes (approximate)", b: `Most states tax wages on top of federal tax — nine don't (AK, FL, NV, NH, SD, TN, TX, WA, WY). Some are flat (Illinois 4.95%), some progressive (California up to 12.3%).<br><br>Planwize applies your state's rates as an <strong>approximation</strong>: real state returns have deductions, credits, and exemptions we don't model.<br><br><strong>Two quirks worth knowing:</strong> Pennsylvania taxes your pre-tax 401(k) contributions (no state deduction — but generally doesn't tax withdrawals in retirement). New Jersey <em>does</em> exempt 401(k) deferrals, but not 403(b)/457/IRA contributions.<div class="ex">A few places also charge local income tax (NYC, Philadelphia, many Ohio cities, Maryland counties). If your state shows a local-rate field, check your last pay stub for the rate.</div>` },
  frequency: { t: "Pay frequency", b: `How often your paycheck arrives changes the math per check, not per year:<br><br><strong>Weekly</strong> — 52 checks · <strong>Every two weeks</strong> — 26 · <strong>1st &amp; 15th</strong> — 24 · <strong>Monthly</strong> — 12.<br><br>Not sure? Check your last two pay stubs' dates. "Every two weeks" (biweekly) is the most common in the US.` },
  bonus: { t: "Bonuses and your 401(k)", b: `Most plans apply your contribution % to bonuses too — a 10% bonus with a 6% rate sends 6% of it into your 401(k) automatically.<br><br><strong>Target:</strong> enter it as a % of salary <em>or</em> a dollar amount — whichever you know (the dollar amount wins if you fill both).<br><br><strong>Actual:</strong> bonuses rarely land exactly on target. Once you know the real number, enter it — it overrides the target and the whole plan updates.<div class="ex">No bonus? Leave everything at 0.</div>` },
  filing: { t: "Filing status", b: `How you file federal taxes. It sets your tax brackets and standard deduction:<br><br><strong>Single</strong> — unmarried.<br><strong>Married filing jointly</strong> — you and a spouse file one return (wider brackets, bigger deduction).<br><br>Other statuses exist (head of household, separate) — pick the closer of these two for planning.` },
  salarySchedule: { t: "Salary schedule", b: `Your gross annual salary — before taxes and deductions. Expecting a raise mid-year? Add a row: <strong>"From pay #14, $92,000"</strong> means the new salary starts at paycheck 14. One row is fine for most people.` },
  expectedReturn: { t: "Expected annual return", b: `What your investments earn per year, on average. History for diversified stock-heavy portfolios: roughly <strong>7–10% before inflation</strong>; bonds lower. 7% is a common planning default.<br><br>Nobody knows the future — run it at 5% and 9% too and plan for the range.` }
};

/* ============================================================
   LEARN CARDS (dashboard education row)
   ============================================================ */
const LEARN = [
  { term: "match",        icon: "M12 2v20M5 9l7-7 7 7", lt: "The only free money in finance", ls: "How the employer match works" },
  { term: "ssWageBase",   icon: "M3 17l6-6 4 4 8-8",    lt: "Why paychecks grow in the fall", ls: "The Social Security cutoff" },
  { term: "megaBackdoor", icon: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5", lt: "Mega backdoor Roth", ls: "The hidden lane past the limit" },
  { term: "preVsRoth",    icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", lt: "Pre-tax or Roth?", ls: "Decide in one minute" },
  { term: "trueUp",       icon: "M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z", lt: "The front-loading trap", ls: "Maxing out too fast costs match" },
  { term: "compounding",  icon: "M4 20h16M6 16l4-6 4 3 4-8", lt: "Compounding, explained", ls: "Why starting now beats starting big" },
  { term: "fourPct",      icon: "M9 14l6-6M9.5 8.5h.01M14.5 13.5h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z", lt: "The 4% rule", ls: "Turn a balance into an income" },
  { term: "catchup",      icon: "M13 5l7 7-7 7M5 5l7 7-7 7", lt: "Catch-up at 50+", ls: "Extra room later in the game" }
];

/* ============================================================
   FORMATTING + DOM HELPERS
   ============================================================ */
const $ = id => document.getElementById(id);
const money = n => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const money2 = n => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = n => (n * 100).toFixed(n * 100 % 1 ? 2 : 0) + "%";
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2600); }
function openGloss(term) {
  const g = GLOSSARY[term]; if (!g) return;
  $("glossTitle").textContent = g.t;
  $("glossBody").innerHTML = g.b;
  $("glossModal").classList.add("open");
}

/* ============================================================
   INSIGHTS ENGINE
   ============================================================ */
function buildInsights(s, R) {
  const out = [];
  const a = age(s);
  const rateTiers = [...s.rateTiers].sort((x, y) => x.start - y.start);
  const currentRate = tierAt(rateTiers, R.N, "pre") + tierAt(rateTiers, R.N, "roth");

  if (currentRate < s.matchCap) {
    out.push({ kind: "warn", t: "You're leaving free money on the table",
      p: `Your contribution rate (${currentRate}%) is below the ${s.matchCap}% needed to capture the full employer match. Capturing the entire match is the single highest-return move in retirement saving — it's an instant ${s.matchRate}% return.`,
      src: "Fidelity Viewpoints & Vanguard 'How America Saves' — max the match first." });
  } else {
    out.push({ kind: "good", t: "Full employer match captured",
      p: `You contribute at least ${s.matchCap}% every pay period, so you earn the entire ${money(R.maxMatch)} match available this year.`,
      src: "Fidelity Viewpoints — capture the full match before anything else." });
  }

  if (R.cappedAt && R.cappedAt < R.N && s.trueUp !== "yes") {
    const lost = Math.max(0, R.maxMatch - R.matchTotal);
    if (lost > 1) out.push({ kind: "warn", t: `Front-loading is costing you ${money(lost)} of match`,
      p: `You hit the ${money(R.lim)} limit in pay period ${R.cappedAt} of ${R.N}. Paychecks after that get no match unless your plan trues up. Dial the rate to ${pct(R.maxRate)} to fill the limit on your final paycheck instead — same contribution, more match.`,
      src: "Standard per-payroll match mechanics; confirm true-up in your plan's Summary Plan Description." });
  }

  const savingsRate = (R.defTotal + R.afterTotal + R.matchTotal) / R.grossYTD;
  if (savingsRate < 0.15) {
    out.push({ kind: "info", t: `Total savings rate: ${pct(savingsRate)} — Fidelity's guideline is 15%`,
      p: `Fidelity's rule of thumb is saving 15% of pre-tax income annually (including employer match) starting at 25 to retire comfortably at 67. You're at ${pct(savingsRate)}; each extra 1% is about ${money(R.grossYTD * 0.01 / R.N)} per paycheck.`,
      src: "Fidelity Viewpoints — 'How much should I save for retirement?' (15% guideline)." });
  } else {
    out.push({ kind: "good", t: `Savings rate ${pct(savingsRate)} — above the 15% guideline`,
      p: `Including your employer match, you're saving above Fidelity's 15% benchmark. Nice position to be in.`,
      src: "Fidelity Viewpoints — 15% savings-rate guideline." });
  }

  const milestones = [[30,1],[35,2],[40,3],[45,4],[50,6],[55,7],[60,8],[67,10]];
  let target = null;
  for (const [ma, mult] of milestones) if (a >= ma) target = mult;
  if (target !== null && s.balance > 0) {
    const salary = tierAt([...s.salaryTiers].sort((x,y)=>x.start-y.start), R.N, "salary");
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
    const mustRoth = R.grossYTD > R.L.rothCatchUpWageThreshold;
    out.push({ kind: "info", t: "Catch-up contributions unlocked",
      p: `At ${a}, you can defer an extra ${money(a>=60&&a<=63?R.L.catchUp60to63:R.L.catchUp50)} this year.${mustRoth ? " Because your wages exceed " + money(R.L.rothCatchUpWageThreshold) + ", SECURE 2.0 requires catch-up contributions to be Roth starting 2026." : ""}`,
      src: "IRS COLA notice; SECURE 2.0 Act §603." });
  } else if (a >= 45) {
    out.push({ kind: "info", t: "Catch-up contributions start at 50",
      p: `In ${50 - a} years you can add ${money(R.L.catchUp50)}+ on top of the regular limit — worth building into your long-range plan.`,
      src: "IRS retirement topics — catch-up contributions." });
  }

  if (R.afterTotal > 0) {
    out.push({ kind: "info", t: "After-tax contributions: convert them",
      p: `Your ${money(R.afterTotal)} of after-tax contributions only shine if converted to Roth (the "mega backdoor"). Left unconverted, their earnings are taxed as ordinary income. Check that your plan allows in-plan Roth conversion or in-service withdrawal.`,
      src: "Fidelity — 'Mega backdoor Roth' explainer; IRC §415(c)." });
  }

  const sd = R.stateInfo;
  if (sd && sd.type === "none") {
    out.push({ kind: "good", t: `${sd.name} has no state income tax`,
      p: `Every pre-tax dollar you defer still saves federal tax, and your take-home stretches further than in most states. One planning note: if you might retire in a state that does tax income, Roth dollars contributed now come out tax-free there too.`,
      src: "State revenue departments — nine states levy no wage income tax." });
  } else if (sd && sd.taxes401k) {
    out.push({ kind: "warn", t: `${sd.name} taxes your 401(k) contributions anyway`,
      p: `Pennsylvania gives no state deduction for pre-tax 401(k) contributions — your ${money(R.preTotal)} still gets taxed at ${sd.rate}% by the state now. The flip side most people miss: PA generally doesn't tax retirement-plan withdrawals after 59½, so you're not taxed twice. Your combined tax savings shown here counts federal only, which is accurate for PA.`,
      src: "PA Department of Revenue — elective deferrals are taxable compensation; qualified retirement income is exempt." });
  } else if (sd && R.stateSaved > 1) {
    out.push({ kind: "good", t: `Pre-tax deferrals also cut your ${sd.name} tax by ~${money(R.stateSaved)}`,
      p: `On top of ${money(R.taxSaved)} in federal savings, your state (approximately) taxes ${money(R.preTotal)} less of your income. Combined, deferring is discounted ~${pct((R.taxSaved + R.stateSaved) / Math.max(1, R.preTotal))} by the tax code.`,
      src: "State bracket data (approximate) — verify with your state's revenue department." });
  }

  if (R.neTotal > 0) {
    out.push({ kind: "good", t: `Your employer adds ${money(R.neTotal)} automatically`,
      p: `On top of any match, your plan deposits a ${s.employerBasePct}% non-elective contribution — yours regardless of what you contribute. Combined with the match, that's ${money(R.neTotal + R.matchTotal)} of employer money this year, all counted in your projection.`,
      src: "Plan non-elective/core contribution — verify timing and basis (current vs prior-year salary) in your plan documents." });
  }

  if (R.bonusIsActual && Math.abs(R.bonus - R.bonusTarget) > 1 && R.bonusTarget > 0) {
    const diff = R.bonus - R.bonusTarget;
    out.push({ kind: "info", t: `Actual bonus came in ${money(Math.abs(diff))} ${diff > 0 ? "above" : "below"} target`,
      p: `Your plan now uses the actual ${money(R.bonus)} bonus. ${diff > 0 ? "Nice — consider steering some of the extra into your contribution rate before year-end." : "The schedule, match, and tax figures have been updated to the real number."}`,
      src: "Planwize — actual bonus overrides target." });
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
   SAFE CHART CREATION — a missing/blocked chart library or a
   canvas problem must never take down the rest of the app.
   ============================================================ */
function makeChart(canvasId, config, key) {
  const cnv = $(canvasId);
  if (!cnv) return;
  try {
    if (charts[key]) { charts[key].destroy(); charts[key] = null; }
    if (typeof window.Chart === "undefined") throw new Error("chart library unavailable");
    charts[key] = new Chart(cnv, config);
    cnv.style.display = "";
    const fb = cnv.parentElement.querySelector(".chart-fallback");
    if (fb) fb.remove();
  } catch (e) {
    console.error("chart '" + key + "':", e);
    cnv.style.display = "none";
    if (!cnv.parentElement.querySelector(".chart-fallback")) {
      const d = document.createElement("div");
      d.className = "chart-fallback";
      d.textContent = "Chart couldn't load here — the numbers above are still correct.";
      cnv.parentElement.appendChild(d);
    }
  }
}

/* ============================================================
   GATING — results stay hidden until the user calculates
   ============================================================ */
function gate() {
  const on = !!state.calculated;
  document.querySelectorAll("[data-gate]").forEach(el => el.hidden = on);
  document.querySelectorAll("[data-gated]").forEach(el => el.hidden = !on);
}

/* ============================================================
   VALIDATION — friendly, specific, points at the field
   ============================================================ */
function validate(s) {
  const errs = [];
  const N = (FREQ[s.frequency] || FREQ.biweekly).n;
  const add = (msg, ids = []) => errs.push({ msg, ids });

  const sal0 = s.salaryTiers[0];
  if (!sal0 || !(+sal0.salary > 0))
    add("Annual salary is missing — enter your yearly pay before taxes (e.g. 85000).", ["salaryTable"]);
  s.salaryTiers.forEach((t, i) => {
    if (i > 0 && !(+t.salary > 0)) add(`Salary row ${i + 1} has no amount — fill it in or remove the row.`, ["salaryTable"]);
    if (+t.start < 1 || +t.start > N) add(`Salary row ${i + 1}: "From pay #" must be between 1 and ${N} for your pay frequency.`, ["salaryTable"]);
  });

  if (!(+s.birthYear >= 1900 && +s.birthYear <= s.planYear - 15))
    add("Birth year looks off — enter a four-digit year (e.g. 1990).", ["birthYear"]);

  if ((s.frequency === "weekly" || s.frequency === "biweekly")) {
    const d = new Date(s.firstPay + "T12:00:00");
    if (!s.firstPay || isNaN(d)) add("First pay date is missing — pick your first paycheck of the year.", ["firstPay"]);
    else if (d.getFullYear() !== +s.planYear || d.getMonth() > 0)
      add(`First pay date should be in January ${s.planYear}.`, ["firstPay"]);
  }

  s.rateTiers.forEach((t, i) => {
    const pre = +t.pre, roth = +t.roth, after = +t.after;
    if (pre < 0 || roth < 0 || after < 0) add(`Rate row ${i + 1}: percentages can't be negative.`, ["rateTable"]);
    if (pre + roth > 100) add(`Rate row ${i + 1}: pre-tax + Roth can't exceed 100% of pay.`, ["rateTable"]);
    if (+t.start < 1 || +t.start > N) add(`Rate row ${i + 1}: "From pay #" must be between 1 and ${N}.`, ["rateTable"]);
  });

  if (+s.bonusPct < 0 || +s.bonusPct > 200) add("Bonus % looks off — enter it as a percent of salary (e.g. 10).", ["bonusPct"]);
  if (+s.bonusAmt < 0) add("Target bonus amount can't be negative.", ["bonusAmt"]);
  if (+s.bonusActual < 0) add("Actual bonus can't be negative — leave it 0 until you know the real number.", ["bonusActual"]);
  if (+s.matchRate < 0 || +s.matchRate > 200) add("Match rate looks off — 50 means 50 cents per dollar you contribute.", ["matchRate"]);
  if (+s.matchCap < 0 || +s.matchCap > 100) add("Match cap looks off — it's the % of your pay the match applies to (e.g. 6).", ["matchCap"]);
  if (+s.employerBasePct < 0 || +s.employerBasePct > 25) add("Automatic employer contribution looks off — it's typically 0 to 10 (% of salary).", ["employerBasePct"]);

  if (!(+s.retireAge > age(s)))
    add(`Retirement age must be later than your current age (${age(s)}).`, ["retireAge"]);
  if (+s.balance < 0) add("Current balance can't be negative — use 0 if you're just starting.", ["balance"]);
  if (+s.expReturn < -20 || +s.expReturn > 30) add("Expected return looks off — most planners use 5 to 9 (percent per year).", ["expReturn"]);
  if (+s.contribGrowth < 0 || +s.contribGrowth > 30) add("Contribution growth looks off — 2 to 3 (percent) is typical.", ["contribGrowth"]);
  if (+s.localRate < 0 || +s.localRate > 8) add("Local tax rate looks off — most local income taxes are 0.5 to 4 (percent). Check your pay stub.", ["localRate"]);

  return errs;
}
function showValidation(errs) {
  const card = $("valCard"), list = $("valList");
  document.querySelectorAll(".invalid").forEach(el => el.classList.remove("invalid"));
  if (!errs.length) { card.hidden = true; return; }
  list.innerHTML = errs.map(e => `<li data-focus="${e.ids[0] || ""}">${e.msg}</li>`).join("");
  card.hidden = false;
  errs.forEach(e => e.ids.forEach(id => {
    const el = $(id);
    if (!el) return;
    if (el.tagName === "TABLE") el.querySelectorAll("input").forEach(i => i.classList.add("invalid"));
    else el.classList.add("invalid");
  }));
  list.querySelectorAll("li").forEach(li => li.onclick = () => {
    const el = $(li.dataset.focus);
    if (el) (el.tagName === "TABLE" ? el.querySelector("input") : el).focus({ preventScroll: false });
  });
}

/* ============================================================
   RENDER
   ============================================================ */
const CHART_GRID = "rgba(255,255,255,.06)", CHART_TICK = "#93a3c4";

function renderAll() {
  gate();
  $("brandYear").textContent = state.planYear;
  renderIRSFromState();               // IRS readout is useful before calculating too
  if (!state.calculated) { renderHeroStrip(); return; }
  results = compute(state);
  const R = results, s = state;

  renderHeroStrip();
  renderPlanChip();
  // pay strip
  const strip = $("paystrip"); strip.innerHTML = "";
  strip.classList.toggle("dense", R.N > 30);
  for (const r of R.rows) {
    const cell = document.createElement("div");
    const contributing = r.preD + r.rothD > 0.005;
    const full = (r.pre + r.roth) * r.g;
    const partial = contributing && r.preD + r.rothD < full - 0.01;
    cell.className = "cell" + (partial ? " partial" : "") + (r.bon > 0 ? " bonus" : "") + (R.ssStopsAt === r.p ? " ss-stop" : "");
    cell.tabIndex = 0;
    cell.dataset.tip = `Pay #${r.p} · ${r.date.toLocaleDateString("en-US",{month:"short",day:"numeric"})}\nGross ${money2(r.g)}\n401(k) ${money2(r.preD + r.rothD)}${r.bon ? "\nBonus " + money(r.bon) : ""}`;
    const fill = document.createElement("div"); fill.className = "fill";
    fill.style.height = contributing ? Math.max(14, Math.min(100, (r.preD + r.rothD) / (full || 1) * 100)) + "%" : "0";
    cell.appendChild(fill); strip.appendChild(cell);
  }

  // donut
  const used = Math.min(1, R.defTotal / R.lim);
  $("donutPct").textContent = Math.round(used * 100) + "%";
  $("donutCaption").innerHTML = used >= 0.999
    ? `You're using your entire ${money(R.lim)} limit — fully maxed. The IRS usually raises the limit each year, so revisit every January.`
    : `You're contributing ${money(R.defTotal)} of the ${money(R.lim)} the IRS allows — ${money(R.lim - R.defTotal)} of tax-advantaged room is unused. Even +1% per paycheck compounds into real money.`;
  makeChart("limitDonut", {
    type: "doughnut",
    data: { datasets: [{ data: [used, 1 - used], backgroundColor: ["#3ddc97", "#1c2740"], borderWidth: 0 }] },
    options: { cutout: "74%", plugins: { legend: { display: false }, tooltip: { enabled: false } } }
  }, "donut");

  // stats
  $("stLimit").textContent = money(R.lim);
  $("stLimitNote").textContent = `402(g)${R.lim > R.L.deferralLimit402g ? " + catch-up" : ""} · IRS ${R.L._year}`;
  $("stDeferral").textContent = money(R.defTotal);
  const room = R.lim - R.defTotal;
  $("stDeferralNote").innerHTML = room < 1 ? `<span class="pill good">Maxed out</span>` :
    `<span class="pill warn">${money(room)} of room unused</span>`;
  $("stMatch").textContent = money(R.matchTotal + R.neTotal);
  const lost = Math.max(0, R.maxMatch - R.matchTotal);
  $("stMatchNote").innerHTML =
    (R.neTotal > 0 ? `match ${money(R.matchTotal)} · automatic ${money(R.neTotal)}<br>` : "") +
    (lost > 1 ? `<span class="pill bad">${money(lost)} match lost</span>` : `<span class="pill good">Full match captured</span>`);
  $("stTaxSaved").textContent = money(R.taxSaved + R.stateSaved);
  const tsNote = document.querySelector("#stTaxSaved + .note") || $("stTaxSaved").parentElement.querySelector(".note");
  if (tsNote) tsNote.textContent = R.stateInfo
    ? `federal ${money(R.taxSaved)} + state ${money(R.stateSaved)} (approx) vs $0 pre-tax`
    : "vs. contributing $0 pre-tax · add your state in Inputs for full picture";
  $("stMaxRate").textContent = pct(R.maxRate);
  $("stBalance").textContent = money(R.atRet);
  $("stBalanceNote").textContent = `at age ${s.retireAge}, ${s.expReturn}% return`;

  // learn cards
  $("learnRow").innerHTML = LEARN.map(l =>
    `<button class="learn" data-term="${l.term}">
       <span class="ic"><svg fill="none" stroke-width="2" viewBox="0 0 24 24"><path d="${l.icon}"/></svg></span>
       <span class="lt">${l.lt}</span><span class="ls">${l.ls}</span></button>`).join("");

  $("insights").innerHTML = buildInsights(s, R).map(i =>
    `<div class="insight kind-${i.kind}"><div><div class="t">${i.t}</div><p>${i.p}</p><div class="src">Source: ${i.src}</div></div></div>`).join("");

  $("paySub").textContent = `All ${R.N} pays (${FREQ[s.frequency].label}), auto-capped at your IRS limit. Amber rows show where the cap kicks in.`;

  const failed = [];
  const sec = (name, fn) => { try { fn(); } catch (e) { console.error("render " + name + ":", e); failed.push(name); } };
  sec("paychecks", () => renderPayTable(R));
  sec("scenarios", () => renderScenarios());
  sec("projection", () => renderProjection(R));
  sec("IRS figures", () => renderIRS(R));
  if (failed.length) toast("Trouble rendering: " + failed.join(", ") + " — everything else is up to date");
}

function renderHeroStrip() {
  const el = $("heroStrip");
  if (!el || el.childElementCount) return;
  for (let i = 0; i < 26; i++) {
    const c = document.createElement("div"); c.className = "cell";
    const f = document.createElement("div"); f.className = "fill";
    f.style.height = (28 + 44 * Math.abs(Math.sin(i * 0.5))) + "%";
    c.appendChild(f); el.appendChild(c);
  }
}

function renderPayTable(R) {
  const h = ["Pay #","Date","Gross","Pre-tax","Roth","After-tax","Deferral YTD","Room left","Employer $","SS tax","Medicare","Take-home"];
  let html = "<thead><tr>" + h.map(x => `<th>${x}</th>`).join("") + "</tr></thead><tbody>";
  for (const r of R.rows) {
    html += `<tr${R.cappedAt === r.p ? ' class="capped"' : ""}><td>${r.p}${r.bon ? " ●" : ""}</td>
      <td>${r.date.toLocaleDateString("en-US",{month:"short",day:"numeric"})}</td>
      <td>${money2(r.g)}</td><td>${money2(r.preD)}</td><td>${money2(r.rothD)}</td><td>${money2(r.afterD)}</td>
      <td>${money(r.defYTD)}</td><td>${money(Math.max(0,r.room))}</td><td>${money2(r.match + r.ne)}</td>
      <td>${money2(r.ss)}</td><td>${money2(r.med)}</td><td>${money2(r.takeHome)}</td></tr>`;
  }
  html += `</tbody><tfoot><tr><td colspan="2">Totals</td><td>${money(R.grossYTD)}</td><td>${money(R.preTotal)}</td>
    <td>${money(R.rothTotal)}</td><td>${money(R.afterTotal)}</td><td>${money(R.defTotal)}</td><td>—</td>
    <td>${money(R.matchTotal + R.neTotal)}</td><td>${money(R.ssTotal)}</td><td>${money(R.medTotal)}</td><td>—</td></tr></tfoot>`;
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
        <div><dt>State + local tax</dt><dd>${money(c.stTax)}${c.stSaved > 1 ? ' <span class="pill good">saves ' + money(c.stSaved) + "</span>" : ""}</dd></div>
        <div><dt>Take-home / paycheck</dt><dd>${money2(c.perPay)}</dd></div>
      </dl>`;
    row.appendChild(div);
  });
  row.querySelectorAll("input").forEach(inp => inp.addEventListener("change", e => {
    const { i, k } = e.target.dataset;
    state.scenarios[i][k] = +e.target.value || 0;
    persist(); renderScenarios();
  }));

  makeChart("scnChart", {
    type: "bar",
    data: { labels: computed.map(c => c.name),
      datasets: [
        { label: "Take-home", data: computed.map(c => c.takeHome), backgroundColor: "#3ddc97", borderRadius: 6 },
        { label: "Retirement dollars", data: computed.map(c => c.additions), backgroundColor: "#6d8dff", borderRadius: 6 },
        { label: "Federal tax saved", data: computed.map(c => c.taxSaved), backgroundColor: "#f0b350", borderRadius: 6 }
      ] },
    options: { responsive: true,
      plugins: { legend: { position: "bottom", labels: { color: CHART_TICK } } },
      scales: { y: { ticks: { color: CHART_TICK, callback: v => "$" + (v/1000) + "k" }, grid: { color: CHART_GRID } },
                x: { ticks: { color: CHART_TICK }, grid: { display: false } } } }
  }, "scn");
}

function renderProjection(R) {
  $("prjSub").textContent = `Starting from ${money(+state.balance||0)}, contributing ${money(R.additions)} in year one (growing ${state.contribGrowth}%/yr), at ${state.expReturn}% annual return.`;
  $("prjBalance").textContent = money(R.atRet);
  $("prjIncome").textContent = money(R.atRet * 0.04);
  $("prjContrib").textContent = money(R.totalContrib);
  let bg = "rgba(61,220,151,.18)";
  try {
    const ctx = $("prjChart").getContext("2d");
    if (ctx) {
      const grad = ctx.createLinearGradient(0, 0, 0, 260);
      grad.addColorStop(0, "rgba(61,220,151,.35)"); grad.addColorStop(1, "rgba(61,220,151,0)");
      bg = grad;
    }
  } catch (e) { /* gradient is decorative */ }
  makeChart("prjChart", {
    type: "line",
    data: { labels: R.proj.map(r => r.age),
      datasets: [{ label: "Balance", data: R.proj.map(r => r.balance),
        borderColor: "#3ddc97", backgroundColor: bg, fill: true, tension: .3, pointRadius: 0, borderWidth: 2.5 }] },
    options: { responsive: true, plugins: { legend: { display: false },
        tooltip: { callbacks: { title: it => "Age " + it[0].label, label: it => money(it.raw) } } },
      scales: { y: { ticks: { color: CHART_TICK, callback: v => v >= 1e6 ? "$" + (v/1e6).toFixed(1) + "M" : "$" + (v/1e3).toFixed(0) + "k" }, grid: { color: CHART_GRID } },
        x: { title: { display: true, text: "Age", color: CHART_TICK }, ticks: { color: CHART_TICK }, grid: { display: false } } } }
  }, "prj");
}

function renderIRSFromState() { renderIRS({ L: limitsFor(state.planYear) }); }
function renderIRS(R) {
  const L = R.L;
  $("irsYearLabel").textContent = L._year;
  $("irsReadout").innerHTML = [
    ["Employee deferral limit — 402(g)", money(L.deferralLimit402g)],
    ["Catch-up (50+) / enhanced (60–63)", money(L.catchUp50) + " / " + money(L.catchUp60to63)],
    ["Total additions — 415(c)", money(L.totalAdditions415c)],
    ["Social Security wage base", money(L.ssWageBase)],
    ["Standard deduction (" + (state.filing === "single" ? "single" : "married") + ")", money(L.standardDeduction[state.filing])]
  ].map(([k, v]) => `${k}: <strong>${v}</strong>`).join("<br>")
    + (function () {
        const sd = stateData(state);
        if (!sd) return "<br>State income tax: <strong>not selected</strong>";
        if (sd.type === "none") return `<br>State income tax (${sd.name}): <strong>none 🎉</strong>`;
        const desc = sd.type === "flat" ? `flat ${sd.rate}%` : `progressive, top ${sd.brackets[sd.brackets.length-1][1]}%`;
        return `<br>State income tax (${sd.name}): <strong>${desc}</strong> <em style="color:var(--faint)">(approx — verify)</em>`;
      })();
  $("irsSource").textContent = "Loaded automatically from irs-limits.json. Values follow the IRS annual COLA notice and SSA wage-base announcement; the file is versioned so one yearly update reaches every user.";
}

/* ============================================================
   INPUT BINDING
   ============================================================ */
function bindInputs() {
  const stateSel = $("state");
  stateSel.innerHTML = '<option value="">— Skip state tax —</option>' +
    Object.entries(STATES.states || {}).sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([code, sd]) => `<option value="${code}">${sd.name}</option>`).join("");
  const simple = { planYear: "planYear", filing: "filing", birthYear: "birthYear",
    state: "state", localRate: "localRate",
    frequency: "frequency", firstPay: "firstPay",
    bonusPct: "bonusPct", bonusAmt: "bonusAmt", bonusActual: "bonusActual", bonusPeriod: "bonusPeriod",
    matchRate: "matchRate", matchCap: "matchCap", trueUp: "trueUp",
    employerBasePct: "employerBasePct", employerBasePeriod: "employerBasePeriod",
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
      if (id === "frequency") syncFrequencyUI();
      if (id === "state") syncStateUI();
      afterEdit();
    });
  }
  syncFrequencyUI();
  syncStateUI();
  drawTierTables();
  $("addSalary").onclick = () => { state.salaryTiers.push({ start: 1, salary: 0 }); drawTierTables(); };
  $("addRate").onclick = () => { state.rateTiers.push({ start: 1, pre: 0, roth: 0, after: 0 }); drawTierTables(); };
}
function syncStateUI() {
  const sd = stateData(state);
  $("localWrap").style.display = sd && sd.localTaxes ? "" : "none";
}
function syncFrequencyUI() {
  const fixed = state.frequency === "semimonthly" || state.frequency === "monthly";
  $("firstPayWrap").style.display = fixed ? "none" : "";
  $("bonusPeriod").max = FREQ[state.frequency].n;
}
function drawTierTables() {
  const st = $("salaryTable").querySelector("tbody"); st.innerHTML = "";
  state.salaryTiers.forEach((t, i) => {
    st.insertAdjacentHTML("beforeend",
      `<tr><td><input type="number" min="1" value="${t.start}" data-i="${i}" data-k="start" data-t="salary"></td>
       <td><input type="number" value="${t.salary}" data-i="${i}" data-k="salary" data-t="salary"></td>
       <td>${i > 0 ? `<button class="rowbtn" data-del-salary="${i}" aria-label="Remove">×</button>` : ""}</td></tr>`);
  });
  const rt = $("rateTable").querySelector("tbody"); rt.innerHTML = "";
  state.rateTiers.forEach((t, i) => {
    rt.insertAdjacentHTML("beforeend",
      `<tr><td><input type="number" min="1" value="${t.start}" data-i="${i}" data-k="start" data-t="rate"></td>
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
function afterEdit() {
  persist();
  const errs = validate(state);
  showValidation(errs);
  if (!errs.length) renderAllSafe();
}

/* ============================================================
   MULTI-PLAN STORE
   Local: planwize.plans (array) + planwize.currentPlan (id).
   Cloud: one row per plan in Supabase, keyed by the same uuid.
   ============================================================ */
function newId() { return (crypto.randomUUID ? crypto.randomUUID() : "p" + Date.now() + Math.random().toString(16).slice(2)); }

function migrateData(v) {
  if (!v) return v;
  if (!v.frequency) v.frequency = "biweekly";
  if (v.calculated === undefined) v.calculated = true;
  if (v.bonusAmt === undefined) { v.bonusAmt = 0; v.bonusActual = 0; }
  if (v.employerBasePct === undefined) { v.employerBasePct = 0; v.employerBasePeriod = 3; }
  if (v.state === undefined) { v.state = ""; v.localRate = 0; }
  return v;
}

function loadStore() {
  // one-time carry-over from the pre-rename "planwise.*" keys (multi-plan store)
  if (!localStorage.getItem("planwize.plans") && localStorage.getItem("planwise.plans")) {
    localStorage.setItem("planwize.plans", localStorage.getItem("planwise.plans"));
    if (localStorage.getItem("planwise.currentPlan")) localStorage.setItem("planwize.currentPlan", localStorage.getItem("planwise.currentPlan"));
    localStorage.removeItem("planwise.plans"); localStorage.removeItem("planwise.currentPlan");
  }
  try {
    plans = JSON.parse(localStorage.getItem("planwize.plans")) || [];
  } catch { plans = []; }
  // migrate the oldest single-plan key (pre-v8), under either name
  if (!plans.length) {
    let raw = localStorage.getItem("planwize.plan") || localStorage.getItem("planwise.plan");
    if (raw) {
      try {
        const data = migrateData(JSON.parse(raw));
        plans = [{ id: newId(), name: (data.planYear || "My") + " plan", created: Date.now(), updated: Date.now(), data }];
      } catch { /* ignore corrupt */ }
      localStorage.removeItem("planwize.plan"); localStorage.removeItem("planwise.plan");
    }
  }
  plans.forEach(p => p.data = migrateData(p.data));
  currentPlanId = localStorage.getItem("planwize.currentPlan");
  if (!plans.find(p => p.id === currentPlanId)) currentPlanId = plans[0]?.id || null;
  if (!currentPlanId) {
    const p = { id: newId(), name: new Date().getFullYear() + 1 + " plan", created: Date.now(), updated: Date.now(), data: structuredClone(DEFAULT_STATE) };
    plans = [p]; currentPlanId = p.id;
  }
  saveStore();
  return structuredClone(plans.find(p => p.id === currentPlanId).data);
}
function saveStore() {
  localStorage.setItem("planwize.plans", JSON.stringify(plans));
  localStorage.setItem("planwize.currentPlan", currentPlanId);
}
function currentPlan() { return plans.find(p => p.id === currentPlanId); }

let saveTimer = null;
function persist() {
  const p = currentPlan();
  if (p) { p.data = structuredClone(state); p.updated = Date.now(); }
  saveStore();
  renderPlanChip();
  if (session) { clearTimeout(saveTimer); saveTimer = setTimeout(() => cloudSavePlan(p), 900); }
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

/* ---------- cloud sync: one row per plan ---------- */
async function cloudSavePlan(p) {
  if (!supa || !session || !p) return;
  try {
    const row = { id: p.id, user_id: session.user.id, name: p.name, updated_at: new Date(p.updated).toISOString() };
    if (encKeyPass) { row.is_encrypted = true; row.ciphertext = await encryptJSON(p.data, encKeyPass); row.data = null; }
    else { row.is_encrypted = false; row.data = p.data; row.ciphertext = null; }
    const { error } = await supa.from("plans").upsert(row, { onConflict: "id" });
    if (error) throw error;
    $("syncDot").classList.add("on");
  } catch (e) { console.error(e); toast("Cloud save failed — data is still safe on this device"); }
}
async function cloudSaveAll() { for (const p of plans) await cloudSavePlan(p); }
async function cloudDelete(id) {
  if (!supa || !session) return;
  try { await supa.from("plans").delete().eq("id", id); } catch (e) { console.error(e); }
}
async function decryptRow(row) {
  if (!row.is_encrypted) return row.data;
  for (let tries = 0; tries < 3; tries++) {
    if (!encKeyPass) {
      encKeyPass = prompt("Enter your encryption passphrase to unlock your plans:");
      if (encKeyPass === null) { encKeyPass = null; return null; }
    }
    try { return await decryptJSON(row.ciphertext, encKeyPass); }
    catch { alert("That passphrase didn't unlock the data. Try again."); encKeyPass = null; }
  }
  return null;
}
async function cloudSyncDown() {
  if (!supa || !session) return;
  const { data, error } = await supa.from("plans").select("*");
  if (error || !data) return;
  for (const row of data) {
    const local = plans.find(p => p.id === row.id);
    const cloudUpdated = new Date(row.updated_at).getTime();
    if (local && local.updated >= cloudUpdated) continue;   // local is newer
    const d = migrateData(await decryptRow(row));
    if (!d) continue;                                        // locked / skipped
    if (local) { local.data = d; local.name = row.name; local.updated = cloudUpdated; }
    else plans.push({ id: row.id, name: row.name, created: new Date(row.created_at || row.updated_at).getTime(), updated: cloudUpdated, data: d });
  }
  if (!plans.find(p => p.id === currentPlanId)) currentPlanId = plans[0]?.id || currentPlanId;
  saveStore();
  openPlan(currentPlanId, { silent: true });
}

/* ============================================================
   PLAN MANAGER UI
   ============================================================ */
function fmtDate(ts) { return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }); }
function renderPlanChip() {
  const p = currentPlan();
  if (!p) return;
  $("planName").textContent = p.name.length > 22 ? p.name.slice(0, 21) + "…" : p.name;
  const meta = $("planMeta");
  if (meta) meta.textContent = `${p.name} · saved ${fmtDate(p.updated)} · created ${fmtDate(p.created)}`;
}
function refreshInputFields() {
  document.querySelectorAll("#view-inputs input, #view-inputs select").forEach(el => {
    if (el.id && state[el.id] !== undefined) el.value = state[el.id];
  });
  drawTierTables();
  syncFrequencyUI();
  syncStateUI();
}
function openPlan(id, opts = {}) {
  const p = plans.find(x => x.id === id);
  if (!p) return;
  currentPlanId = id;
  state = structuredClone(p.data);
  saveStore();
  refreshInputFields();
  renderPlanChip();
  renderAllSafe();
  if (!opts.silent) { toast(`Opened "${p.name}"`); goto(state.calculated ? "dashboard" : "inputs"); }
}
function renderPlansList() {
  const box = $("plansList");
  box.innerHTML = plans.slice().sort((a, b) => b.updated - a.updated).map(p => `
    <div class="planrow ${p.id === currentPlanId ? "current" : ""}">
      <div class="pmain">
        <div class="pname">${p.name}${p.id === currentPlanId ? ' <span class="pill good">open</span>' : ""}</div>
        <div class="pdates">Saved ${fmtDate(p.updated)} · Created ${fmtDate(p.created)}</div>
      </div>
      <div class="pacts">
        <button data-open="${p.id}" class="chip-btn dark">Open</button>
        <button data-pdf="${p.id}" class="chip-btn dark">PDF</button>
        <button data-rename="${p.id}" class="chip-btn dark">Rename</button>
        <button data-dup="${p.id}" class="chip-btn dark">Duplicate</button>
        <button data-del="${p.id}" class="chip-btn dark danger">Delete</button>
      </div>
    </div>`).join("");
  box.querySelectorAll("[data-open]").forEach(b => b.onclick = () => openPlan(b.dataset.open));
  box.querySelectorAll("[data-pdf]").forEach(b => b.onclick = () => makePDF(plans.find(x => x.id === b.dataset.pdf)));
  box.querySelectorAll("[data-rename]").forEach(b => b.onclick = () => {
    const p = plans.find(x => x.id === b.dataset.rename);
    const name = prompt("Plan name:", p.name);
    if (name && name.trim()) { p.name = name.trim().slice(0, 60); p.updated = Date.now(); saveStore(); renderPlanChip(); renderPlansList(); if (session) cloudSavePlan(p); }
  });
  box.querySelectorAll("[data-dup]").forEach(b => b.onclick = () => {
    const p = plans.find(x => x.id === b.dataset.dup);
    const copy = { id: newId(), name: (p.name + " (copy)").slice(0, 60), created: Date.now(), updated: Date.now(), data: structuredClone(p.data) };
    plans.push(copy); saveStore(); renderPlansList(); if (session) cloudSavePlan(copy);
    toast("Duplicated — great for what-if runs or a second job");
  });
  box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    const p = plans.find(x => x.id === b.dataset.del);
    if (plans.length === 1) { toast("This is your only plan — create another before deleting it"); return; }
    if (!confirm(`Delete "${p.name}"? This can't be undone.`)) return;
    plans = plans.filter(x => x.id !== p.id);
    cloudDelete(p.id);
    if (currentPlanId === p.id) { currentPlanId = plans[0].id; openPlan(currentPlanId, { silent: true }); }
    saveStore(); renderPlansList(); renderPlanChip();
    toast("Plan deleted");
  });
}
function createPlan() {
  const name = prompt("Name your plan (e.g. \"2026 — main job\", \"2026 — aggressive Roth\"):",
    (currentPlan()?.data.planYear || new Date().getFullYear()) + " plan");
  if (name === null) return;
  const p = { id: newId(), name: (name.trim() || "Untitled plan").slice(0, 60), created: Date.now(), updated: Date.now(), data: structuredClone(DEFAULT_STATE) };
  plans.push(p); saveStore();
  if (session) cloudSavePlan(p);
  openPlan(p.id);
  goto("inputs");
}

/* ============================================================
   CONTACT / FEEDBACK
   Primary: a Supabase "feedback" table (see schema.sql).
   Fallbacks when no backend: GitHub issues, then email.
   ============================================================ */
const GITHUB_ISSUES_URL = "https://github.com/DoneByAdam/planwize/issues";
const CONTACT_EMAIL = "";   // optional mailto fallback, e.g. "you@example.com"
async function sendFeedback() {
  if ($("fbHoney").value) { $("contactModal").classList.remove("open"); return; }  // bot honeypot
  const category = $("fbCategory").value, message = $("fbMessage").value.trim(), email = $("fbEmail").value.trim();
  const note = $("fbNotice"); note.hidden = true;
  if (message.length < 5) { note.hidden = false; note.textContent = "Tell me a little more — the message looks empty."; return; }
  if (supa) {
    try {
      $("fbSend").disabled = true;
      const { error } = await supa.from("feedback").insert({
        category, message: message.slice(0, 4000), email: email.slice(0, 200) || null,
        context: `plan year ${state.planYear} · ${state.frequency} · v${APP_VERSION}`
      });
      if (error) throw error;
      $("contactModal").classList.remove("open");
      $("fbMessage").value = "";
      toast("Sent — thank you! " + (email ? "I'll reply to your email." : ""));
      return;
    } catch (e) {
      console.error(e);
      note.hidden = false; note.textContent = "Couldn't send just now. You can also open an issue on GitHub: " + GITHUB_ISSUES_URL;
      return;
    } finally { $("fbSend").disabled = false; }
  }
  // no backend configured
  if (CONTACT_EMAIL) {
    location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("Planwize " + category)}&body=${encodeURIComponent(message)}`;
  } else {
    note.hidden = false;
    note.innerHTML = `Feedback needs the Supabase backend (see README), or use GitHub: <a href="${GITHUB_ISSUES_URL}" target="_blank" rel="noopener">open an issue</a>.`;
  }
}

/* ============================================================
   AUTH UI
   ============================================================ */
let authMode = "signin";
function setupAuth() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) {
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    supa.auth.getSession().then(({ data }) => { session = data.session; refreshAuthUI(); if (session) cloudSyncDown(); });
    supa.auth.onAuthStateChange((_e, s2) => { session = s2; refreshAuthUI(); });
  } else refreshAuthUI();

  $("authBtn").onclick = () => {
    if (session) { supa.auth.signOut(); encKeyPass = null; toast("Signed out — device-only mode"); }
    else openAuth("signin");
  };
  $("bannerSignup").onclick = () => openAuth("signup");
  $("tabSignin").onclick = () => setAuthMode("signin");
  $("tabSignup").onclick = () => setAuthMode("signup");
  document.querySelectorAll(".modal [data-close]").forEach(b => b.onclick = () => b.closest(".modal").classList.remove("open"));
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.classList.remove("open"); }));

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
      if (authMode === "signup") { await cloudSaveAll(); toast("Account created — all your plans are saved to it"); }
      else { await cloudSyncDown(); await cloudSaveAll(); toast("Signed in — plans synced"); }
      refreshAuthUI();
    } catch (e) {
      notice.hidden = false; notice.textContent = e.message || "Sign-in failed. Check email and password.";
    } finally { $("authSubmit").disabled = false; }
  };
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
function makePDF(planObj) {
  const s = planObj ? migrateData(structuredClone(planObj.data)) : state;
  if (!s.calculated || (!planObj && !results)) { toast("Calculate that plan first — then the report has something to say"); goto("inputs"); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { toast("PDF library couldn't load — check your connection and refresh"); return; }
  const R = planObj ? compute(s) : results;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const G = [43, 184, 124], INK = [15, 23, 42];
  doc.setFillColor(...INK); doc.rect(0, 0, 210, 30, "F");
  doc.setTextColor(255).setFont("helvetica", "bold").setFontSize(18);
  doc.text(`Planwize — ${s.planYear} 401(k) Contribution Plan`, 14, 13);
  doc.setFontSize(9).setFont("helvetica", "normal");
  const cp = planObj || currentPlan();
  doc.text(`Plan: ${cp ? cp.name : "My plan"} · Generated ${new Date().toLocaleDateString()} · Paid ${FREQ[s.frequency].label} (${R.N} checks) · Filing: ${s.filing === "single" ? "Single" : "Married filing jointly"} · Age ${age(s)}`, 14, 21);
  if (cp) { doc.setFontSize(8); doc.text(`Numbers last saved ${fmtDate(cp.updated)} · plan created ${fmtDate(cp.created)}`, 14, 26); }

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
      ["Automatic employer contribution", R.neTotal > 0 ? money(R.neTotal) + ` (${s.employerBasePct}% of salary)` : "None"],
      ["Total annual additions (415(c) limit " + money(R.L.totalAdditions415c) + ")", money(R.additions)],
      ["Federal marginal rate", pct(R.marginal)],
      ["State + local income tax (approx)", R.stateInfo ? money(R.stateTax + R.localTax) + " (" + R.stateInfo.name + ")" : "Not selected"],
      ["Tax saved by pre-tax deferrals (fed + state)", money(R.taxSaved + R.stateSaved)],
      ["Rate that maxes the limit exactly", pct(R.maxRate)],
      ["Social Security tax stops", R.ssStopsAt ? "Pay #" + R.ssStopsAt + " of " + R.N : "Not reached"],
      ["Bonus in plan", R.bonus > 0 ? money(R.bonus) + (R.bonusIsActual ? " (actual)" : " (target)") : "None"],
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
  doc.text("DISCLAIMER: Planwize is for guidance and reference only. It is not tax, legal, or investment advice. Estimates use simplified", 14, 286);
  doc.text("federal and approximate state assumptions. Consult a tax professional or accountant before acting. Verify figures at irs.gov.", 14, 291);
  doc.save(`Planwize_${(cp ? cp.name : s.planYear + " plan").replace(/[^\w\d-]+/g, "_").slice(0, 40)}.pdf`);
  toast("Report downloaded");
}

/* ============================================================
   NAV + GLOSSARY WIRING + BOOT
   ============================================================ */
function renderAllSafe() {
  try { renderAll(); }
  catch (e) {
    console.error(e);
    toast("Couldn't update the results (" + (e.message || "unknown error") + ") — your inputs are saved");
  }
}
function goto(view) {
  if (view === "plans") renderPlansList();
  document.querySelectorAll(".nav button").forEach(x => x.classList.toggle("active", x.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + view));
  window.scrollTo({ top: 0 });
}
document.querySelectorAll(".nav button").forEach(b => b.onclick = () => goto(b.dataset.view));
document.addEventListener("click", e => {
  const g = e.target.closest("[data-goto]");
  if (g) goto(g.dataset.goto);
});
function runCalculate() {
  const errs = validate(state);
  showValidation(errs);
  if (errs.length) {
    toast(errs.length === 1 ? "One thing needs fixing — see the red card" : errs.length + " things need fixing — see the red card");
    if ($("valCard").scrollIntoView) $("valCard").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  state.calculated = true;
  persist();
  renderAllSafe();
  goto("dashboard");
  toast("Your plan is ready");
}
document.addEventListener("click", e => {
  const btn = e.target.closest("[data-term]");
  if (btn) { e.preventDefault(); openGloss(btn.dataset.term); }
});
$("reportBtn").onclick = () => makePDF();

(async function boot() {
  try {
    const r = await fetch("irs-limits.json", { cache: "no-store" });
    if (r.ok) IRS = await r.json();
  } catch { /* offline — fallback stays */ }
  try {
    const r2 = await fetch("state-taxes.json", { cache: "no-store" });
    if (r2.ok) STATES = await r2.json();
  } catch { /* offline — state tax simply reads $0 with a note */ }
  $("guestBanner").hidden = false;
  bindInputs();
  setupAuth();
  $("calcBtn").onclick = runCalculate;
  $("ctaStart").onclick = () => goto("inputs");
  $("ctaStart2").onclick = () => goto("inputs");
  $("ctaSample").onclick = () => {
    state = structuredClone(DEFAULT_STATE);
    state.calculated = true;
    persist();
    refreshInputFields();
    renderAllSafe();
    goto("dashboard");
    toast("Sample plan loaded — explore, then make it yours in Inputs");
  };
  $("plansBtn").onclick = () => goto("plans");
  $("newPlanBtn").onclick = createPlan;
  $("contactBtn").onclick = (e) => { e.preventDefault(); $("contactModal").classList.add("open"); };
  $("contactBtn2").onclick = (e) => { e.preventDefault(); $("contactModal").classList.add("open"); };
  $("contactBtn3").onclick = (e) => { e.preventDefault(); $("contactModal").classList.add("open"); };
  $("verStamp").textContent = "Planwize v" + APP_VERSION;
  const expBtn = $("exportBtn"), delBtn = $("deleteAllBtn");
  if (expBtn) expBtn.onclick = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), plans }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "planwize-export.json"; link.click();
    URL.revokeObjectURL(url);
    toast("Downloaded — every plan, in plain JSON");
  };
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Delete all ${plans.length} plan(s)? This can't be undone.`)) return;
    for (const p of plans) await cloudDelete(p.id);
    plans = [{ id: newId(), name: new Date().getFullYear() + " plan", created: Date.now(), updated: Date.now(), data: structuredClone(DEFAULT_STATE) }];
    currentPlanId = plans[0].id;
    saveStore();
    openPlan(currentPlanId, { silent: true });
    toast("All plans deleted — starting fresh");
    goto("home");
  };
  $("fbSend").onclick = sendFeedback;
  renderPlanChip();
  if (state.calculated) renderAllSafe(); else { gate(); renderIRSFromState(); renderHeroStrip(); }
})();
