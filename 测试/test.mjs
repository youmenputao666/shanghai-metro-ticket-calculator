import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = [
  'index.html',
  '上海地铁计次票划算计算器.html',
  '../上海地铁计次票划算计算器.html',
  '../index.html'
].map(p => path.resolve(here, p)).find(p => fs.existsSync(p));
assert.ok(htmlPath, '找不到计算器 HTML');
const html = fs.readFileSync(htmlPath, 'utf8');
const core = html.split('/* CORE_START */')[1].split('/* CORE_END */')[0];
assert.ok(core && core.length > 1000, 'core block found');

const api = new Function(core + `
  return { CARD_TYPES, defaultCalendarText, parseCalendar, isWorkday, buildRides, ptCost,
           evaluatePlan, planSchedule, cardPlans, analyze, breakEvenFare, parseISO, isoOf, addDays,
           scheduleSim, schedulePlans };
`)();

const { parseCalendar, defaultCalendarText, buildRides, ptCost, evaluatePlan, planSchedule, cardPlans,
        analyze, breakEvenFare, parseISO, isoOf, addDays, scheduleSim, schedulePlans } = api;

function form(overrides = {}) {
  const cal = parseCalendar(defaultCalendarText());
  return Object.assign({
    start: parseISO('2026-12-01'),
    validityDays: 31,
    fare: 5,
    perWorkday: 2,
    perOffDay: 0,
    threshold: 90,
    rate: 0.9,
    cal
  }, overrides);
}

// ---------- 节假日数据 ----------
{
  const cal = parseCalendar(defaultCalendarText());
  assert.equal(cal.holidays.size, 90, 'default holiday count');
  assert.equal(cal.makeup.size, 16, 'default makeup count');
  assert.deepEqual([...cal.years].sort(), [2025, 2026, 2027]);
  assert.equal(cal.errors.length, 0);

  // 2026 春节前后
  assert.equal(api.isWorkday(parseISO('2026-02-14'), cal), true, '2026-02-14 调休上班');
  assert.equal(api.isWorkday(parseISO('2026-02-16'), cal), false, '2026-02-16 春节');
  assert.equal(api.isWorkday(parseISO('2026-10-10'), cal), true, '2026-10-10 调休上班');
  // 2027 元旦、春节调休
  assert.equal(api.isWorkday(parseISO('2027-01-01'), cal), false);
  assert.equal(api.isWorkday(parseISO('2027-02-14'), cal), true);
}

// ---------- 区间解析 ----------
{
  const cal = parseCalendar('2026-01-01~2026-01-03 元旦\n2026-01-04 班\n2026-02-15~2026-02-23 春节');
  assert.equal(cal.holidays.size, 12);
  assert.equal(cal.makeup.size, 1);
  assert.equal(cal.errors.length, 0);
  const bad = parseCalendar('2026-13-01 元旦\nnot-a-date x');
  assert.equal(bad.errors.length, 2);
}

// ---------- A：默认口径 2026-12-01 + 31 天（官方：激活当日及之后 30 个自然日） ----------
{
  const res = analyze(form());
  assert.equal(res.workdays, 23, 'December 2026 workdays (31-day window)');
  assert.equal(res.rideCount, 46);
  assert.ok(Math.abs(res.base.total - 216) < 1e-9, 'base 216, got ' + res.base.total);
  const best = res.best;
  assert.equal(best.label, '45次×1');
  assert.ok(Math.abs(best.total - 215) < 1e-9, 'best 215, got ' + best.total);
  assert.ok(Math.abs(best.savings - 1) < 1e-9, 'savings 1, got ' + best.savings);
  assert.equal(best.used, 45);
  assert.equal(best.leftover, 0);

  // 四张卡都算出来，按总花费排序：45(215) < 35(245) < 60(270) < 90(390)
  assert.deepEqual(res.cards.map(p => p.total), [215, 245, 270, 390]);
  assert.equal(res.cards[0].savings, 1);
  assert.equal(res.cards[1].savings, 216 - 245);

  const p35 = evaluatePlan([1,0,0,0], res.rides, form());
  assert.ok(Math.abs(p35.total - 245) < 1e-9, '35 card total 245, got ' + p35.total);
  const p60 = evaluatePlan([0,0,1,0], res.rides, form());
  assert.equal(p60.leftover, 14);
  assert.equal(p60.used, 46);
}

// ---------- B：2026-12-15 + 31 天（跨月） ----------
{
  const res = analyze(form({ start: parseISO('2026-12-15') }));
  assert.equal(res.workdays, 22, 'workdays got ' + res.workdays);
  assert.equal(res.rideCount, 44);
  assert.ok(Math.abs(res.base.total - 216) < 1e-9, 'base 216, got ' + res.base.total);
  const best = res.best;
  assert.equal(best.label, '45次×1');
  assert.ok(Math.abs(best.total - 210) < 1e-9);
  assert.equal(best.leftover, 1);
  assert.ok(Math.abs(best.savings - 6) < 1e-9, 'savings got ' + best.savings);
}

// ---------- C：2026-02-10 春节 + 调休 ----------
{
  const res = analyze(form({ start: parseISO('2026-02-10') }));
  assert.equal(res.workdays, 19, 'workdays got ' + res.workdays);
  assert.equal(res.makeupDays, 2, 'makeup days in window');
  assert.equal(res.rideCount, 38);
  assert.ok(Math.abs(res.base.total - 189) < 1e-9, 'base 189, got ' + res.base.total);
  const p35 = evaluatePlan([1,0,0,0], res.rides, form({ start: parseISO('2026-02-10') }));
  assert.ok(Math.abs(p35.total - 205) < 1e-9, '35 card 205, got ' + p35.total);
  assert.ok(res.best.total >= res.base.total, 'no card is worth it here');
}

// ---------- D：2027-01-20 跨 2027 春节、票价 6 ----------
{
  const f = form({ start: parseISO('2027-01-20'), fare: 6 });
  const res = analyze(f);
  // 2027-01-20 ~ 2027-02-19：含 1/31、2/14 两个周日调休，且 2/5–2/13 春节，共 19 个工作日
  assert.equal(res.workdays, 19, 'workdays got ' + res.workdays);
  assert.equal(res.rideCount, 38);
  // 1 月 9 个工作日=18 次：90+3×5.4=106.2；2 月 10 个工作日=20 次：90+5×5.4=117 → 223.2
  assert.ok(Math.abs(res.base.total - 223.2) < 1e-9, 'base 223.2, got ' + res.base.total);
  const best = res.best;
  assert.equal(best.label, '35次×1');
  assert.ok(Math.abs(best.total - 208) < 1e-9, 'best 208, got ' + best.total);
  assert.ok(Math.abs(best.savings - 15.2) < 1e-9, 'savings got ' + best.savings);
}

// ---------- E：30 天与 31 天的差别（口径回归） ----------
{
  const d30 = analyze(form({ validityDays: 30 }));
  assert.equal(d30.rideCount, 44);
  assert.equal(d30.workdays, 22);
  assert.ok(Math.abs(d30.base.total - 207) < 1e-9, 'base 207, got ' + d30.base.total);

  const d31 = analyze(form({ validityDays: 31 }));
  assert.equal(d31.rideCount, 46);
  assert.ok(Math.abs(d31.base.total - 216) < 1e-9, 'base 216, got ' + d31.base.total);
  assert.ok(Math.abs(d31.best.total - 215) < 1e-9);
}

// ---------- F：月度累计重置 ----------
{
  const rides = [];
  // 2026-11：16 次 ×6 元 = 96（前 15 次满 90，第 16 次 9 折 → 95.4）
  for (let i = 0; i < 16; i++) rides.push({ date: '2026-11-02', month: '2026-11', fare: 6 });
  // 2026-12：10 次 ×6 元 = 60（不足 90，无折扣）
  for (let i = 0; i < 10; i++) rides.push({ date: '2026-12-01', month: '2026-12', fare: 6 });
  const c = ptCost(rides, 90, 0.9);
  assert.ok(Math.abs(c.total - (95.4 + 60)) < 1e-9, 'monthly reset, got ' + c.total);
  assert.equal(c.months.length, 2);
}

// ---------- G：只比单卡（次卡 + 直刷），不存在两张卡 ----------
{
  const res = analyze(form());
  assert.equal(res.cards.length, 4, 'four card types');
  assert.ok(res.cards.every(p => p.cards === 1), 'each plan uses exactly one card');
  assert.ok(res.cards.every(p => p.cardCount <= 90));
  assert.equal(res.cards[0].label, '45次×1');
  // 排序后总花费单调不减
  for (let i = 1; i < res.cards.length; i++) assert.ok(res.cards[i].total >= res.cards[i-1].total);
  // cardPlans 与 analyze().cards 结果一致
  const again = cardPlans(res.rides, form());
  assert.deepEqual(again.map(p => p.total), res.cards.map(p => p.total));
}

// ---------- H：保本票价 ----------
{
  const be = breakEvenFare(form());
  assert.ok(be !== null && Math.abs(be - 5.0) < 1e-9, 'break-even 5.0, got ' + be);
}

// ---------- I：日期工具 ----------
{
  assert.equal(isoOf(addDays(parseISO('2026-12-31'), 1)), '2027-01-01');
  assert.equal(isoOf(addDays(parseISO('2026-02-28'), 1)), '2026-03-01');
}

// ---------- J：按天拆解（日历数据） ----------
{
  const f = form();
  const res = analyze(f);

  // 35 次卡：卡内 35 次、其余 11 次刷卡，且刷卡发生在有效期尾部
  const p35 = evaluatePlan([1,0,0,0], res.rides, f);
  const sched = planSchedule(p35, res.rides, f);
  let cardDays = 0, paidDays = 0, cardTotal = 0, paidTotal = 0, costSum = 0;
  sched.forEach(rec => {
    if (rec.card) { cardDays++; cardTotal += rec.card; }
    if (rec.paid) { paidDays++; paidTotal += rec.paid; }
    costSum += rec.cost;
  });
  assert.equal(cardTotal, 35, 'card rides total');
  assert.equal(paidTotal, 11, 'paid rides total');
  assert.ok(cardDays <= 23, 'card rides never exceed workdays');
  assert.ok(paidDays >= 1);
  assert.ok(Math.abs(costSum - p35.pt.total) < 1e-9, 'cash sum equals pt total, got ' + costSum);
  assert.ok(Math.abs(costSum - 55) < 1e-9, '11 cash rides cost 55, got ' + costSum);
  assert.equal(sched.get('2026-12-31').card + sched.get('2026-12-31').paid, 2, 'last window day has 2 rides');

  // 纯刷卡方案：次卡 0 次，当天成本全部是刷卡金额
  const baseSched = planSchedule(evaluatePlan([0,0,0,0], res.rides, f), res.rides, f);
  assert.equal(baseSched.get('2026-12-01').card, 0);
  assert.equal(baseSched.get('2026-12-01').paid, 2);
  let sum = 0;
  baseSched.forEach(rec => { sum += rec.cost; });
  assert.ok(Math.abs(sum - res.base.total) < 1e-9, 'base schedule sums to base total');

  // 9 折从当月第 19 次（共 46 次、票价 5：前 18 次 5 元满 90）开始生效
  const discounted = [...baseSched.values()].reduce((s, r) => s + r.discounted, 0);
  assert.equal(discounted, 46 - 18, 'rides 19..46 are discounted');
}

// ---------- K：错峰排期（先直刷、晚点激活） ----------
{
  const cal = parseCalendar(defaultCalendarText());
  const span = {
    fromISO: '2027-01-20', toISO: '2027-03-31',
    fare: 6, perWorkday: 2, perOffDay: 0, cal, threshold: 90, rate: 0.9, validityDays: 31
  };

  const cash = scheduleSim(Object.assign({}, span, { cards: [] }));
  assert.ok(Math.abs(cash.total - 534.6) < 1e-6, '全直刷 534.6，实得 ' + cash.total);
  assert.equal(cash.cardRides, 0);
  assert.equal(cash.cashRides, 94, '区间内 47 个工作日 × 2 = 94 次');

  // 45 次卡等到春节后的 3/1 才激活：¥210 + 直刷 ¥283.20 = ¥493.20
  const one = scheduleSim(Object.assign({}, span, { cards: [{ i: 1, startISO: '2027-03-01' }] }));
  assert.equal(one.cardCost, 210);
  assert.equal(one.cardRides, 45);
  assert.equal(one.leftover, 0);
  assert.ok(Math.abs(one.total - 493.2) < 1e-6, '错峰 493.2，实得 ' + one.total);

  // 第一天（1/20）就激活：窗口只含 19 个工作日，卡浪费 7 次 → ¥527.40
  const imm = scheduleSim(Object.assign({}, span, { cards: [{ i: 1, startISO: '2027-01-20' }] }));
  assert.ok(Math.abs(imm.total - 527.4) < 1e-6, '立刻激活 527.4，实得 ' + imm.total);
  assert.equal(imm.leftover, 7);

  // 两张 45 次卡接力（1/20 + 2/22）= ¥486.00
  const two = scheduleSim(Object.assign({}, span, { cards: [{ i: 1, startISO: '2027-01-20' }, { i: 1, startISO: '2027-02-22' }] }));
  assert.ok(Math.abs(two.total - 486) < 1e-6, '两张卡 486，实得 ' + two.total);

  // 逐日现金合计 == 方案现金
  const daySum = one.days.reduce((s, d) => s + d.cost, 0);
  assert.ok(Math.abs(daySum - one.cash) < 0.02, '逐日现金合计应等于现金总额，差 ' + (daySum - one.cash));

  // 搜索：最佳单卡应为 3/1 激活的 493.2；组合不应差于手动最优 486
  const out = schedulePlans(Object.assign({}, span, { maxCards: 2 }));
  assert.ok(out.bestOne && Math.abs(out.bestOne.total - 493.2) < 1e-6, 'bestOne 应为 493.2');
  assert.equal(out.bestOne.plan[0].startISO, '2027-03-01');
  assert.ok(out.best.total <= 486 + 1e-6, '搜索应不差于 486，实得 ' + out.best.total);
  assert.ok(out.best.total < out.immediate.total, '排期应优于第一天就激活');
  assert.ok(Math.abs(out.base.total - 534.6) < 1e-6);

  // 区间过短时不崩溃：2/1–2/3 共 3 个工作日、6 次 × ¥6 = ¥36
  const tiny = schedulePlans(Object.assign({}, span, { fromISO: '2027-02-01', toISO: '2027-02-03', maxCards: 1 }));
  assert.equal(tiny.base.total, 36, '短区间全直刷应为 36，实得 ' + tiny.base.total);
}

console.log('ALL TESTS PASSED');
