// Page-turn trigger & animation suite (PT-*).
// Complements design.spec.mjs (fold geometry D5-D9) by pinning down the
// TRIGGER side: click zones, keyboard, buttons, wheel, drag commit/cancel,
// turn-queue behavior, book-edge guards, fx variants — and the chapter-pill
// click-stealing regression (pills used to overlap the page's left border at
// mid-height and silently chapter-jump instead of flipping).
//
// Position oracle: assertions use rendition.currentLocation() (renderer
// truth). The page badge (LocEngine global paging) legitimately lags for
// freshly-entered chapters because global indexing runs on idle, so badge
// equality is only asserted where the chapter was already indexed.
import { test, expect } from '@playwright/test';
import { fresh, openDemoReady, badge, badgeWait, slowDrag, synUp, viewerFrame, spreadInfo } from './helpers.mjs';

const MID = 430; // chapter-iframe-local y used by the drag helpers too

async function geo(page) {
  return page.evaluate(() => {
    const v = document.getElementById('viewer').getBoundingClientRect();
    return { left: v.left, right: v.right, top: v.top, w: v.width, h: v.height };
  });
}
async function clickFlip(page, dir, offset = 300) {
  const g = await geo(page);
  const y = g.top + g.h / 2;
  const x = dir > 0 ? g.right - offset : g.left + offset;
  await page.mouse.click(x, y);
}
const chapter = (page) => page.locator('#chapter').textContent();
// Renderer-truth position: spine index + displayed page of the spread start.
async function pos(page) {
  return page.evaluate(() => {
    try {
      const l = state.rendition.currentLocation();
      return {
        idx: l && l.start ? l.start.index : -1,
        page: l && l.start && l.start.displayed ? l.start.displayed.page : 0,
        href: l && l.start ? String(l.start.href) : null,
      };
    } catch (e) { return { idx: -1, page: 0, href: null }; }
  });
}
const posKey = (p) => `${p.idx}#${p.page}`;
async function settlePos(page, prev, timeout = 9000) {
  await page.waitForFunction((k) => {
    try {
      const l = state.rendition.currentLocation();
      const cur = l && l.start ? `${l.start.index}#${l.start.displayed ? l.start.displayed.page : 0}` : null;
      return cur && cur !== k && !document.body.classList.contains('turning');
    } catch (e) { return false; }
  }, posKey(prev), { timeout });
  await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout });
  await page.waitForTimeout(120);
}
const badgeNum = async (page) => {
  const m = (await badge(page)).match(/\d+/);
  return m ? +m[0] : 0;
};

test.describe('page-turn triggers', () => {

  test('PT1 left-border clicks flip back exactly like a clean-zone flip (pill regression)', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // Walk into chapter 1 and stop at a mid-chapter spread: one spread behind
    // and one ahead, so a back flip must land in the SAME chapter.
    let p = await pos(page);
    for (let i = 0; i < 8 && !(p.idx > 0 && p.page >= 2); i++) {
      await clickFlip(page, 1);
      await settlePos(page, p);
      p = await pos(page);
    }
    expect(p.idx, 'walk reached chapter 1').toBeGreaterThan(0);
    const startCh = await chapter(page);
    // Reference landing for one back flip from p
    await clickFlip(page, -1);
    await settlePos(page, p);
    const ref = await pos(page);
    expect(ref.idx).toBe(p.idx);          // same chapter
    expect(ref.page).toBeLessThan(p.page);
    await clickFlip(page, 1);
    await settlePos(page, ref);
    expect(posKey(await pos(page))).toBe(posKey(p));
    // Suspect: the page's LEFT BORDER at mid page height — the exact spot
    // where the invisible chapter pill used to intercept clicks.
    const g = await geo(page);
    for (const off of [2, 20, 60, 100, 150]) {
      await page.mouse.click(g.left + off, g.top + g.h / 2);
      await settlePos(page, p);
      const landing = await pos(page);
      expect(landing.idx, `left-border click +${off}px must not jump chapters`).toBe(p.idx);
      expect(landing.page, `left-border click +${off}px must flip exactly one spread`).toBe(ref.page);
      await clickFlip(page, 1);
      await settlePos(page, landing);
      expect(posKey(await pos(page))).toBe(posKey(p));
    }
    expect(await chapter(page)).toBe(startCh);
  });

  test('PT2 right-page click flips forward; left-page click flips back', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const p0 = await pos(page);
    await clickFlip(page, 1);
    await settlePos(page, p0);
    const p1 = await pos(page);
    const fwd = p1.idx > p0.idx || (p1.idx === p0.idx && p1.page > p0.page);
    expect(fwd, 'right-page click moves forward').toBe(true);
    await clickFlip(page, -1);
    await settlePos(page, p1);
    expect(posKey(await pos(page)), 'left-page click returns to the start spread').toBe(posKey(p0));
  });

  test('PT3 single-page mode: left 28% back, right 72% forward', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // Navigation recorder for failure diagnostics
    await page.evaluate(() => {
      window.__navlog = [];
      const stamp = () => Math.round(performance.now());
      const r = state.rendition;
      for (const m of ['next', 'prev']) {
        const orig = r[m].bind(r);
        r[m] = (...a) => { window.__navlog.push(`${m}@${stamp()}`); return orig(...a); };
      }
      const origT = window.turn;
      window.turn = function (dir) { window.__navlog.push(`turn(${dir})@${stamp()}`); return origT(dir); };
    });
    await page.evaluate(() => { settings.spread = 'none'; save(); relayout(); });
    await page.waitForFunction(() => !document.body.classList.contains('spread'), null, { timeout: 9000 });
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
    // wait for the recreated chapter iframe to sit at the viewer origin
    await page.waitForFunction(() => {
      const fr = document.querySelector('#viewer iframe');
      const v = document.getElementById('viewer');
      if (!fr || !v) return false;
      return Math.abs(fr.getBoundingClientRect().left - v.getBoundingClientRect().left) < 2;
    }, null, { timeout: 9000 });
    const g = await geo(page);
    const y = g.top + g.h / 2;
    const p0 = await pos(page);
    await page.mouse.click(g.right - 40, y); // far right -> next page
    await settlePos(page, p0);
    const p1 = await pos(page);
    expect(p1.idx > p0.idx || (p1.idx === p0.idx && p1.page > p0.page), 'far-right click moves forward').toBe(true);
    await page.mouse.click(g.left + 40, y);  // far left -> prev page
    try {
      await settlePos(page, p1);
    } catch (e) {
      const navlog = await page.evaluate(() => (window.__navlog || []).join(' | '));
      throw new Error(`back click did not navigate; navlog=[${navlog}]; p0=${JSON.stringify(p0)} p1=${JSON.stringify(p1)}`);
    }
    expect(posKey(await pos(page))).toBe(posKey(p0));
  });

  test('PT4 keyboard triggers: arrows, space, page keys', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const p0 = await pos(page);
    for (const key of ['ArrowRight', ' ', 'PageDown']) {
      await page.keyboard.press(key);
      await settlePos(page, p0);
      const p = await pos(page);
      expect(p.idx > p0.idx || (p.idx === p0.idx && p.page > p0.page), `${key} moves forward`).toBe(true);
      await page.keyboard.press('ArrowLeft');
      await settlePos(page, p);
      expect(posKey(await pos(page)), `${key} then ArrowLeft returns`).toBe(posKey(p0));
    }
  });

  test('PT5 prev/next buttons flip with the fold compositor and clean it up', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // In auto-width spread mode the book fills the window and #stage gets
    // .no-arrows (pointer-events:none) — shrink the book so the arrows are
    // really live, and pin that the pill does not intercept them.
    await page.evaluate(() => { settings.widthAuto = false; settings.widthSpread = 720; save(); relayout(); });
    await page.waitForFunction(() => !document.getElementById('stage').classList.contains('no-arrows'), null, { timeout: 9000 });
    // the relayout recreates the rendition — wait for a valid location
    await page.waitForFunction(() => {
      try {
        const l = state.rendition.currentLocation();
        return !!(l && l.start && l.start.displayed && l.start.displayed.total);
      } catch (e) { return false; }
    }, null, { timeout: 9000 });
    const p0 = await pos(page);
    await page.click('#btnNext');
    const appeared = await page.waitForFunction(() => !!document.querySelector('.pt-compositor'), null, { timeout: 3000 })
      .then(() => true).catch(() => false);
    expect(appeared, 'paper fx should mount the fold compositor').toBe(true);
    await settlePos(page, p0);
    const p1 = await pos(page);
    expect(p1.idx > p0.idx || (p1.idx === p0.idx && p1.page > p0.page), 'btnNext moves forward').toBe(true);
    await page.waitForFunction(() => !document.querySelector('.pt-compositor'), null, { timeout: 5000 });
    await page.click('#btnPrev');
    await settlePos(page, p1);
    expect(posKey(await pos(page))).toBe(posKey(p0));
  });

  test('PT6 wheel over the page turns forward and back', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const g = await geo(page);
    await page.mouse.move(g.left + g.w / 2, g.top + g.h / 2);
    const p0 = await pos(page);
    await page.mouse.wheel(0, 140);
    await settlePos(page, p0);
    const p1 = await pos(page);
    expect(p1.idx > p0.idx || (p1.idx === p0.idx && p1.page > p0.page), 'wheel down moves forward').toBe(true);
    await page.mouse.wheel(0, -140);
    await settlePos(page, p1);
    expect(posKey(await pos(page))).toBe(posKey(p0));
  });

  test('PT7 drag past commit threshold flips, small drag cancels', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    let p = await pos(page);
    for (let i = 0; i < 8 && !(p.idx > 0 && p.page >= 2); i++) {
      await clickFlip(page, 1);
      await settlePos(page, p);
      p = await pos(page);
    }
    const start = p;
    await slowDrag(page, -1, 0.5);          // backward, past 0.38 commit
    await synUp(page);
    await settlePos(page, start);
    const back = await pos(page);
    expect(back.idx < start.idx || (back.idx === start.idx && back.page < start.page),
      'deep drag commits a backward turn').toBe(true);
    await clickFlip(page, 1);
    await settlePos(page, back);
    expect(posKey(await pos(page))).toBe(posKey(start));
    await slowDrag(page, -1, 0.12);         // shallow drag, no velocity
    await synUp(page);
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 8000 });
    await page.waitForTimeout(200);
    expect(posKey(await pos(page)), 'shallow drag must cancel').toBe(posKey(start));
  });

  test('PT8 spread mode blocks wrong-direction drags on each page half', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    let p = await pos(page);
    for (let i = 0; i < 8 && !(p.idx > 0 && p.page >= 2); i++) {
      await clickFlip(page, 1);
      await settlePos(page, p);
      p = await pos(page);
    }
    const start = await pos(page);
    const frame = await viewerFrame(page);
    const info = await spreadInfo(page);
    // The chapter iframe is 2x viewer width in spread mode and #viewer scrolls
    // between its halves, so the iframe element legitimately sits at
    // viewer.left - scrollLeft. "Settled" = it exactly covers the viewer.
    const waitFrameSettled = () => page.waitForFunction(() => {
      const fr = document.querySelector('#viewer iframe');
      const v = document.getElementById('viewer');
      if (!fr || !v) return false;
      const r = fr.getBoundingClientRect();
      const s = v.getBoundingClientRect();
      return r.left <= s.left + 2 && r.right >= s.right - 2;
    }, null, { timeout: 9000 });
    await waitFrameSettled();
    // Visible dispatch points: map main-doc page coordinates into the frame's
    // viewport through its LIVE rect (the iframe may be scrolled halfway).
    const visibleX = async (mainX) => page.evaluate(({ mainX }) => {
      const fr = document.querySelector('#viewer iframe').getBoundingClientRect();
      return Math.round(mainX - fr.left);
    }, { mainX });
    const dragInFrame = async ({ mainX, dx }) => {
      const x0 = await visibleX(mainX);
      await frame.evaluate(({ x0, dx, y }) => {
        const mk = (type, x) => new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          button: 0, buttons: 1, pointerId: 7, pointerType: 'mouse', isPrimary: true,
        });
        const tgt = (x) => document.elementFromPoint(x, y) || document.body;
        tgt(x0).dispatchEvent(mk('pointerdown', x0));
        for (let i = 1; i <= 5; i++) tgt(x0 + (dx * i) / 5).dispatchEvent(mk('pointermove', x0 + (dx * i) / 5));
      }, { x0, dx, y: MID });
      const st = await page.evaluate(() => ({
        comp: !!document.querySelector('.pt-compositor'),
        active: turnGesture.active,
        turning: state.turning,
      }));
      expect(st, `no drag state for refused drag (mainX=${mainX}, dx=${dx})`).toEqual({
        comp: false, active: false, turning: false,
      });
      await synUp(page);
      await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 8000 });
      await page.waitForTimeout(200);
    };
    await dragInFrame({ mainX: info.left + 150, dx: -Math.round(info.spreadW * 0.4) });
    expect(posKey(await pos(page)), 'left-page leftward drag must not flip').toBe(posKey(start));
    await waitFrameSettled();
    await dragInFrame({ mainX: info.left + info.spreadW - 150, dx: Math.round(info.spreadW * 0.4) });
    expect(posKey(await pos(page)), 'right-page rightward drag must not flip').toBe(posKey(start));
  });

  test('PT9 rapid click burst drains the queue exactly like paced clicks', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // paced reference: 3 single flips forward
    let p = await pos(page);
    for (let i = 0; i < 3; i++) { await clickFlip(page, 1); await settlePos(page, p); p = await pos(page); }
    const paced = p;
    // walk back 3 flips to the start
    for (let i = 0; i < 3; i++) { await clickFlip(page, -1); await settlePos(page, p); p = await pos(page); }
    const start = p;
    // burst: 3 rapid clicks, no waiting between
    for (let i = 0; i < 3; i++) { await clickFlip(page, 1); await page.waitForTimeout(40); }
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 12000 });
    await page.waitForTimeout(300);
    const final = await pos(page);
    expect(posKey(final), 'every queued click must land, same direction').toBe(posKey(paced));
    expect(posKey(final)).not.toBe(posKey(start));
  });

  test('PT10 click landing mid-fold queues instead of dropping (net +2 spreads)', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // paced reference for two forward flips
    let p = await pos(page);
    for (let i = 0; i < 2; i++) { await clickFlip(page, 1); await settlePos(page, p); p = await pos(page); }
    const two = p;
    // back to start
    for (let i = 0; i < 2; i++) { await clickFlip(page, -1); await settlePos(page, p); p = await pos(page); }
    const start = p;
    // one key turn + one click fired inside the fold window
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await clickFlip(page, 1);
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 12000 });
    await page.waitForTimeout(300);
    const final = await pos(page);
    expect(posKey(final), 'mid-fold click must queue, not vanish').toBe(posKey(two));
    expect(posKey(final)).not.toBe(posKey(start));
  });

  test('PT11 at book start, left-zone click is a no-op (edge guard)', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const p0 = await pos(page);
    await clickFlip(page, -1);
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 5000 });
    expect(posKey(await pos(page))).toBe(posKey(p0));
  });

  test('PT12 chapter pills never overlap the book page (desk clamp)', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const r = await page.evaluate(() => {
      const v = document.getElementById('viewer').getBoundingClientRect();
      const p = document.getElementById('chLabelPrev').getBoundingClientRect();
      const n = document.getElementById('chLabelNext').getBoundingClientRect();
      return {
        vLeft: v.left, vRight: v.right,
        pLeft: p.left, pRight: p.right, pW: p.width,
        nLeft: n.left, nRight: n.right, nW: n.width,
        prevVisible: getComputedStyle(document.getElementById('chLabelPrev')).visibility !== 'hidden',
        nextVisible: getComputedStyle(document.getElementById('chLabelNext')).visibility !== 'hidden',
      };
    });
    expect(r.prevVisible, 'prev pill fits the desk at this viewport').toBe(true);
    expect(r.nextVisible).toBe(true);
    expect(r.pRight, 'left pill stays left of the page').toBeLessThanOrEqual(r.vLeft + 1);
    expect(r.nLeft, 'right pill stays right of the page').toBeGreaterThanOrEqual(r.vRight - 1);
    expect(r.pW).toBeLessThanOrEqual(176);
  });

  test('PT13 pill click mid-fold is dropped; pill still jumps when idle', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    // One flip forward lands mid-chapter-1 with a spread ahead in the SAME
    // chapter, so the fold itself must not change the chapter.
    const p0 = await pos(page);
    await clickFlip(page, 1);
    await settlePos(page, p0);
    const startCh = await chapter(page);
    const pill = await page.evaluate(() => {
      const r = document.getElementById('chLabelNext').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    // a forward fold in flight: a mid-turn pill click must be dropped
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    await page.mouse.click(pill.x, pill.y);
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 12000 });
    await page.waitForTimeout(300);
    expect(await chapter(page), 'no chapter jump while turning').toBe(startCh);
    // idle pill click still jumps one chapter (feature intact after clamping)
    await page.waitForTimeout(250);
    await page.mouse.click(pill.x, pill.y);
    await page.waitForFunction((ch) => document.getElementById('chapter').textContent !== ch,
      startCh, { timeout: 9000 });
    await page.waitForFunction(() => !document.body.classList.contains('turning'), null, { timeout: 9000 });
    expect(await chapter(page)).not.toBe(startCh);
  });

  test('PT14 slide and instant fx variants still navigate correctly', async ({ page }) => {
    await fresh(page);
    await openDemoReady(page);
    const p0 = await pos(page);
    await page.evaluate(() => { settings.turnFx = 'slide'; save(); });
    await page.keyboard.press('ArrowRight');
    await settlePos(page, p0);
    const p1 = await pos(page);
    expect(p1.idx > p0.idx || (p1.idx === p0.idx && p1.page > p0.page), 'slide fx moves forward').toBe(true);
    await page.evaluate(() => { settings.turnFx = 'none'; save(); });
    await page.keyboard.press('ArrowLeft');
    await settlePos(page, p1, 6000);
    expect(posKey(await pos(page)), 'instant fx returns to the start spread').toBe(posKey(p0));
    await page.evaluate(() => { settings.turnFx = 'paper'; save(); });
  });

});
