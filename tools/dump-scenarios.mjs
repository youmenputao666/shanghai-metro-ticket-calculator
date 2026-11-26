// 导出典型场景的结算结果，方便其他 AI / 人对照数值。
// 用法：node tools/dump-scenarios.mjs > 示例输出/scenarios.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, '..', '上海地铁计次票划算计算器.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const core = html.split('/* CORE_START */')[1].split('/* CORE_END */')[0];
if (!core || core.length < 1000) throw new Error('CORE 段未找到');

const api = new Function(core + `
  return { CARD_TYPES, defaultCalendarText, parseCalendar, buildRides, ptCost,
           evaluatePlan, planSchedule, cardPlans, analyze, breakEvenFare, parseISO, isoOf, addDays,
           scheduleSim, schedulePlans };
`)();

const cal = api.parseCalendar(api.defaultCalendarText());

function scenario(name, overrides) {
  const input = Object.assign({
    start: api.parseISO('2026-12-01'),
    validityDays: 31,
    fare: 5,
    perWorkday: 2,
    perOffDay: 0,
    threshold: 90,
    rate: 0.9,
    cal
  }, overrides);
  const res = api.analyze(input);
  const be = api.breakEvenFare(input);
  const cards = res.cards.map(p => ({
    label: p.label,
    cardPrice: round(p.cardPrice),
    used: p.used,
    leftover: p.leftover,
    unit: round(p.unit),
    total: round(p.total),
    savings: round(p.savings)
  }));
  // 推荐方案的逐日排布（只保留有乘车的日子）
  const sched = api.planSchedule(res.best.total <= res.base.total ? res.best : api.evaluatePlan([0, 0, 0, 0], res.rides, input), res.rides, input);
  const days = [...sched.values()].map(d => ({
    date: d.iso, card: d.card, paid: d.paid, cost: round(d.cost), discounted: d.discounted
  }));
  return {
    name,
    input: {
      start: api.isoOf(input.start), validityDays: input.validityDays, fare: input.fare,
      perWorkday: input.perWorkday, perOffDay: input.perOffDay,
      threshold: input.threshold, rate: input.rate
    },
    workdays: res.workdays,
    makeupDays: res.makeupDays,
    rides: res.rideCount,
    base: { total: round(res.base.total), months: res.base.months.map(m => ({ month: m.month, rides: m.rides, cost: round(m.cost), discounted: m.discounted })) },
    cards,
    best: res.best.label,
    recommendation: res.best.savings > 0.005 ? 'buy' : 'no-buy',
    breakEvenFare: be,
    scheduleSample: days.slice(0, 3).concat(days.slice(-2))
  };
}

const round = v => Math.round(v * 100) / 100;

// 错峰排期：给定区间，先直刷、某天再激活
function scheduleScenario(name, fromISO, toISO, fare) {
  const out = api.schedulePlans({
    fromISO, toISO, fare, perWorkday: 2, perOffDay: 0,
    threshold: 90, rate: 0.9, validityDays: 31, cal
  });
  return {
    name,
    range: { from: fromISO, to: toISO, fare, perWorkday: 2 },
    allCash: round(out.base.total),
    cardCount: out.best.plan.length,
    best: {
      cards: out.best.plan.map(p => api.CARD_TYPES[p.i].count + '次卡'),
      starts: out.best.plan.map(p => p.startISO),
      cardCost: round(out.best.cardCost),
      cash: round(out.best.cash),
      total: round(out.best.total),
      savings: round(out.base.total - out.best.total)
    },
    bestSingle: out.bestOne ? { start: out.bestOne.plan[0].startISO, total: round(out.bestOne.total) } : null,
    activateFirstDay: out.immediate ? { start: out.immediate.plan[0].startISO, total: round(out.immediate.total) } : null,
    candidates: out.plans.slice(0, 5).map(p => ({
      cards: p.name,
      starts: p.plan.map(c => c.startISO),
      total: round(p.total)
    }))
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  notes: [
    'validityDays=31 是本工具的默认口径（官方：激活当日及之后 30 个自然日 = 31 天）。',
    'cards 为「买一张该卡 + 剩余乘次照常刷卡」的结算；savings = 纯刷卡 - 该方案。',
    'recommendation=buy 当且仅当最便宜的单卡比纯刷卡便宜超过 0.005 元。'
  ],
  cardTypes: api.CARD_TYPES,
  scenarios: [
    scenario('2026-12-01 激活，¥5，2 次/工作日（31 天，默认）'),
    scenario('2026-12-15 激活，¥5（31 天）', { start: api.parseISO('2026-12-15') }),
    scenario('2026-02-10 激活，¥5，跨春节（31 天）', { start: api.parseISO('2026-02-10') }),
    scenario('2027-01-20 激活，¥6，含 2027 春节（31 天）', { start: api.parseISO('2027-01-20'), fare: 6 }),
    scenario('对照：2026-12-01 激活，¥5，30 天口径（旧）', { validityDays: 30 })
  ],
  scheduleScenarios: [
    scheduleScenario('2026-12-01 ~ 2027-02-28，¥5（元旦 + 春节）', '2026-12-01', '2027-02-28', 5),
    scheduleScenario('2027-01-20 ~ 2027-03-31，¥6（春节后激活最省）', '2027-01-20', '2027-03-31', 6),
    scheduleScenario('2026-09-20 ~ 2026-12-31，¥6（国庆后激活最省）', '2026-09-20', '2026-12-31', 6),
    scheduleScenario('2026-12-01 ~ 2027-05-29，¥5（默认半年）', '2026-12-01', '2027-05-29', 5),
    scheduleScenario('2026-03-01 ~ 2027-02-28，¥6（整整一年）', '2026-03-01', '2027-02-28', 6)
  ]
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
