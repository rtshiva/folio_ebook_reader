import { test, expect } from '@playwright/test';
import { fresh, openDemoReady } from './helpers.mjs';

test('PO-FLIP: snapshot leaves retain corner fleurons on Page 1 and continuation header on Page 2 during flip', async ({ page }) => {
  await fresh(page);
  await openDemoReady(page);

  // 1. On Page 1 (opening page), verify live view and simulate compositor snapshot
  const probeP1 = await page.evaluate(() => {
    const snap = snapshotPage();
    const { box, snap: sIframe } = createSnapBox(snap, 0, snap.vRect.width, 0);
    document.body.appendChild(box);
    populateSnap(sIframe, snap.docHtml, null, 0);

    const sDoc = sIframe.contentDocument;
    const pcs = sDoc ? sDoc.getElementById('folio-pcs') : null;
    const tl = sDoc ? sDoc.querySelector('.folio-pg.tl') : null;
    const ph = sDoc ? sDoc.querySelector('.folio-ph.simple') : null;
    const cs = sDoc ? sDoc.defaultView : null;

    const result = {
      isOpening: pcs ? pcs.classList.contains('opening') : false,
      cornerDisplay: tl && cs ? cs.getComputedStyle(tl).display : null,
      headerDisplay: ph && cs ? cs.getComputedStyle(ph).display : null,
      width: pcs ? pcs.style.width : null,
      transform: pcs ? pcs.style.transform : null
    };

    box.remove();
    return result;
  });

  console.log('PAGE 1 SNAPSHOT PROBE:', probeP1);
  expect(probeP1.isOpening).toBe(true);
  expect(probeP1.cornerDisplay).toBe('block'); // Corner fleurons stay visible on Page 1 leaf!
  expect(probeP1.headerDisplay).toBe('none');  // Middle-top header stays hidden on Page 1 leaf!

  // 2. On Page 2 (continuation spread, relLeft = -stepW), verify snapshot leaf has continuation header
  const probeP2 = await page.evaluate(() => {
    const snap = snapshotPage();
    const stepW = snap.vRect.width;
    const { box, snap: sIframe } = createSnapBox(snap, 0, stepW, -stepW);
    document.body.appendChild(box);
    populateSnap(sIframe, snap.docHtml, null, -stepW);

    const sDoc = sIframe.contentDocument;
    const pcs = sDoc ? sDoc.getElementById('folio-pcs') : null;
    const tl = sDoc ? sDoc.querySelector('.folio-pg.tl') : null;
    const ph = sDoc ? sDoc.querySelector('.folio-ph.simple') : null;
    const cs = sDoc ? sDoc.defaultView : null;

    const result = {
      isOpening: pcs ? pcs.classList.contains('opening') : false,
      cornerDisplay: tl && cs ? cs.getComputedStyle(tl).display : null,
      headerDisplay: ph && cs ? cs.getComputedStyle(ph).display : null,
      width: pcs ? pcs.style.width : null,
      transform: pcs ? pcs.style.transform : null
    };

    box.remove();
    return result;
  });

  console.log('PAGE 2 SNAPSHOT PROBE:', probeP2);
  expect(probeP2.isOpening).toBe(false);
  expect(probeP2.cornerDisplay).toBe('none');  // Corner fleurons hidden on Page 2 leaf!
  expect(probeP2.headerDisplay).toBe('block'); // Middle-top header visible on Page 2 leaf!
});
