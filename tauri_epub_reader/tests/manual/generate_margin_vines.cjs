// Port of the procedural botanical-vine generators (01 delicate climbing
// vine v3, 02 wildflower vine, 03 ivy margin) to Node — identical node
// specs and builders, with the shared helpers (fmt/rot/leaf/tendril)
// reconstructed. Outputs rich_ebook_ornaments/*.svg at the repo root.
const fs = require('fs');
const path = require('path').resolve(__dirname, '../../rich_ebook_ornaments').replace(/\/g, '/') + '/';
fs.mkdirSync(path, { recursive: true });

function fmt(n) {
  let s = n.toFixed(2);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}
function rot(x, y, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  return [cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r)];
}
function evalCubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const x = (u ** 3) * p0[0] + 3 * (u ** 2) * t * p1[0] + 3 * u * (t ** 2) * p2[0] + (t ** 3) * p3[0];
  const y = (u ** 3) * p0[1] + 3 * (u ** 2) * t * p1[1] + 3 * u * (t ** 2) * p2[1] + (t ** 3) * p3[1];
  return [x, y];
}
function buildSpine(segments) {
  const dParts = ['M' + fmt(segments[0][0][0]) + ' ' + fmt(segments[0][0][1])];
  const sampled = [];
  for (const [p0, p1, p2, p3] of segments) {
    dParts.push('C' + fmt(p1[0]) + ' ' + fmt(p1[1]) + ' ' + fmt(p2[0]) + ' ' + fmt(p2[1]) + ' ' + fmt(p3[0]) + ' ' + fmt(p3[1]));
    for (let i = 0; i <= 200; i++) sampled.push(evalCubicBezier(p0, p1, p2, p3, i / 200));
  }
  const getXAtY = (ty) => {
    let best = sampled[0];
    for (const pt of sampled) if (Math.abs(pt[1] - ty) < Math.abs(best[1] - ty)) best = pt;
    return best[0];
  };
  return [dParts.join(' '), getXAtY];
}
function makeBezierTendril(cx, cy, scale, angleDeg, flipX = 1) {
  const g = (lx, ly) => rot(cx + lx * flipX * scale, cy + ly * scale, cx, cy, angleDeg);
  const p0 = g(0, 0);
  const c1 = g(0.15, -0.55), c2 = g(0.75, -0.95), p1 = g(0.95, -0.55);
  const c3 = g(1.10, -0.20), c4 = g(0.65, 0.15), p2 = g(0.40, -0.15);
  const c5 = g(0.22, -0.38), c6 = g(0.52, -0.62), p3 = g(0.65, -0.42);
  const c7 = g(0.72, -0.28), c8 = g(0.52, -0.18), p4 = g(0.48, -0.32);
  return ('M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' C' + fmt(c1[0]) + ' ' + fmt(c1[1]) + ' ' + fmt(c2[0]) + ' ' + fmt(c2[1]) + ' ' + fmt(p1[0]) + ' ' + fmt(p1[1]) +
    ' C' + fmt(c3[0]) + ' ' + fmt(c3[1]) + ' ' + fmt(c4[0]) + ' ' + fmt(c4[1]) + ' ' + fmt(p2[0]) + ' ' + fmt(p2[1]) +
    ' C' + fmt(c5[0]) + ' ' + fmt(c5[1]) + ' ' + fmt(c6[0]) + ' ' + fmt(c6[1]) + ' ' + fmt(p3[0]) + ' ' + fmt(p3[1]) +
    ' C' + fmt(c7[0]) + ' ' + fmt(c7[1]) + ' ' + fmt(c8[0]) + ' ' + fmt(c8[1]) + ' ' + fmt(p4[0]) + ' ' + fmt(p4[1]));
}
// Slender pointed botanical leaf: base at (cx,cy), tip `length` along
// angle, half-width `width` across, midrib bowed by `curl`. Returns
// [outline d, vein d].
function makeBotanicalLeaf(cx, cy, length, width, angleDeg, curl = 0) {
  const g = (lx, ly) => rot(cx + lx * width, cy + ly * length, cx, cy, angleDeg);
  const bow = curl * width;
  const p0 = g(0, 0);
  const tip = g(0, -1);
  const c1l = g(-0.55, -0.30), c2l = g(-0.5 + bow * 0.05, -0.68);
  const c1r = g(0.55, -0.30), c2r = g(0.5 + bow * 0.05, -0.68);
  const d = ('M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' C' + fmt(c1l[0]) + ' ' + fmt(c1l[1]) + ' ' + fmt(c2l[0]) + ' ' + fmt(c2l[1]) + ' ' + fmt(tip[0]) + ' ' + fmt(tip[1]) +
    ' C' + fmt(c2r[0]) + ' ' + fmt(c2r[1]) + ' ' + fmt(c1r[0]) + ' ' + fmt(c1r[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) + 'Z');
  const vm = g(bow * 0.5, -0.9);
  const vb = g(bow * 0.3, -0.5);
  const vein = 'M' + fmt(p0[0]) + ' ' + fmt(p0[1]) + ' Q' + fmt(vb[0]) + ' ' + fmt(vb[1]) + ' ' + fmt(vm[0]) + ' ' + fmt(vm[1]);
  return [d, vein];
}

// ---------------- 01 delicate climbing vine (v3) ----------------
function build01() {
  const segs = [
    [[90, 1188], [48, 1085], [132, 1005], [86, 900]],
    [[86, 900], [42, 795], [130, 725], [82, 620]],
    [[82, 620], [38, 515], [128, 445], [84, 340]],
    [[84, 340], [42, 235], [124, 155], [88, 36]]
  ];
  const [spineD, getX] = buildSpine(segs);
  const segs2 = [
    [[96, 1185], [128, 1090], [54, 1005], [94, 900]],
    [[94, 900], [132, 795], [52, 725], [92, 620]],
    [[92, 620], [130, 515], [54, 445], [92, 340]],
    [[92, 340], [128, 235], [58, 155], [88, 36]]
  ];
  const [spine2D] = buildSpine(segs2);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 1200" fill="none">',
    '<defs>',
    '  <linearGradient id="leafGrad01" x1="0%" y1="0%" x2="100%" y2="100%">',
    '    <stop offset="0%" stop-color="#98A77C"/>',
    '    <stop offset="100%" stop-color="#6B7A52"/>',
    '  </linearGradient>',
    '  <linearGradient id="leafSub01" x1="0%" y1="100%" x2="100%" y2="0%">',
    '    <stop offset="0%" stop-color="#B0BF95" stop-opacity="0.82"/>',
    '    <stop offset="100%" stop-color="#84926A" stop-opacity="0.90"/>',
    '  </linearGradient>',
    '</defs>',
    '<path d="' + spine2D + '" stroke="#87936D" stroke-width="1.05" stroke-opacity="0.65" stroke-linecap="round"/>',
    '<path d="' + spineD + '" stroke="#556341" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>'
  ];
  const nodeSpecs = [
    [1135, 34, -40, 1, 34, 14, 38],
    [1065, -40, -48, -1, 44, 18, -38],
    [985, 42, -50, 1, 44, 18, 38],
    [910, -34, -42, -1, 34, 14, -34],
    [840, -42, -50, -1, 45, 19, -38],
    [765, 36, -44, 1, 34, 14, 36],
    [700, 42, -50, 1, 44, 18, 38],
    [630, -32, -40, -1, 33, 13, -32],
    [565, -42, -50, -1, 45, 19, -38],
    [490, 36, -42, 1, 34, 14, 34],
    [425, 42, -50, 1, 44, 18, 38],
    [350, -34, -40, -1, 34, 14, -34],
    [285, -40, -48, -1, 42, 18, -36],
    [210, 38, -46, 1, 40, 17, 36],
    [135, -36, -44, -1, 38, 16, -34],
    [80, 28, -34, 1, 30, 13, 30]
  ];
  const petioles = [], tendrils = [], backLeaves = [], frontLeaves = [], veinPaths = [], berries = [];
  for (const [sy, dx, dy, side, llen, lwid, lang] of nodeSpecs) {
    const sx = getX(sy);
    const bx = sx + dx, by = sy + dy;
    const c1x = sx + side * 12, c1y = sy - 15;
    const c2x = bx - side * 8, c2y = by + 15;
    petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' C' + fmt(c1x) + ' ' + fmt(c1y) + ' ' + fmt(c2x) + ' ' + fmt(c2y) + ' ' + fmt(bx) + ' ' + fmt(by));
    if (llen >= 40) {
      const [mx, my] = evalCubicBezier([sx, sy], [c1x, c1y], [c2x, c2y], [bx, by], 0.52);
      const [subOut, subVein] = makeBotanicalLeaf(mx, my, llen * 0.55, lwid * 0.55, lang + side * 22, side * 0.16);
      backLeaves.push(subOut);
      veinPaths.push(subVein);
      tendrils.push(makeBezierTendril(mx, my, 22, lang - side * 16, -side));
      for (const [bAng, bDist] of [[-side * 22, 13], [-side * 42, 17], [-side * 10, 19]]) {
        const rad = (bAng * Math.PI) / 180;
        const bpx = sx + bDist * Math.sin(rad);
        const bpy = sy - bDist * Math.cos(rad);
        petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' Q' + fmt((sx + bpx) / 2) + ' ' + fmt(sy - 7) + ' ' + fmt(bpx) + ' ' + fmt(bpy));
        berries.push([bpx, bpy, 2.3]);
      }
    } else {
      tendrils.push(makeBezierTendril(sx, sy, 18, -side * 30, -side));
    }
    const [out, vn] = makeBotanicalLeaf(bx, by, llen, lwid, lang, -side * 0.18);
    frontLeaves.push(out);
    veinPaths.push(vn);
  }
  const topX = getX(36);
  for (const [sAng, sLen, sWid] of [[0, 26, 11], [-30, 18, 8], [30, 18, 8]]) {
    const [tout, tvn] = makeBotanicalLeaf(topX, 36, sLen, sWid, sAng, 0);
    frontLeaves.push(tout);
    veinPaths.push(tvn);
  }
  svg.push('<g stroke="#65734F" stroke-width="1.35" stroke-linecap="round"><path d="' + petioles.join(' ') + '"/></g>');
  svg.push('<g stroke="#7A8862" stroke-width="1.0" stroke-linecap="round" opacity="0.88"><path d="' + tendrils.join(' ') + '"/></g>');
  svg.push('<g fill="url(#leafSub01)" stroke="#65734F" stroke-width="1.0" stroke-linejoin="round">');
  for (const p of backLeaves) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g fill="url(#leafGrad01)" stroke="#556341" stroke-width="1.25" stroke-linejoin="round">');
  for (const p of frontLeaves) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#465335" stroke-width="0.65" stroke-linecap="round" opacity="0.75"><path d="' + veinPaths.join(' ') + '"/></g>');
  svg.push('<g fill="#C8AE7E" stroke="#556341" stroke-width="0.9">');
  for (const [bx, by, br] of berries) svg.push('  <circle cx="' + fmt(bx) + '" cy="' + fmt(by) + '" r="' + fmt(br) + '"/>');
  svg.push('</g>');
  svg.push('</svg>');
  return svg.join('\n');
}

// ---------------- 02 wildflower vine ----------------
function makeRosetteFlower(cx, cy, radius, numPetals = 5, rotOffset = 0) {
  const outerPetals = [], innerPetals = [], petalVeins = [], stamens = [], anthers = [];
  for (let i = 0; i < numPetals; i++) {
    const ang = rotOffset + i * (360 / numPetals);
    const g = (lx, ly) => rot(cx + lx, cy + ly, cx, cy, ang);
    const R = radius, W = radius * 0.58;
    const p0 = g(0, 0);
    const c1 = g(-W * 0.95, -R * 0.35), c2 = g(-W * 0.75, -R * 0.95);
    const ptL = g(-W * 0.18, -R * 1.02);
    const notch = g(0, -R * 0.92);
    const ptR = g(W * 0.18, -R * 1.02);
    const c3 = g(W * 0.75, -R * 0.95), c4 = g(W * 0.95, -R * 0.35);
    outerPetals.push('M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
      ' C' + fmt(c1[0]) + ' ' + fmt(c1[1]) + ' ' + fmt(c2[0]) + ' ' + fmt(c2[1]) + ' ' + fmt(ptL[0]) + ' ' + fmt(ptL[1]) +
      ' Q' + fmt(notch[0]) + ' ' + fmt(notch[1]) + ' ' + fmt(ptR[0]) + ' ' + fmt(ptR[1]) +
      ' C' + fmt(c3[0]) + ' ' + fmt(c3[1]) + ' ' + fmt(c4[0]) + ' ' + fmt(c4[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) + 'Z');
    for (const vAng of [-10, 0, 10]) {
      const vp = rot(cx, cy - R * 0.68, cx, cy, ang + vAng);
      petalVeins.push('M' + fmt(cx) + ' ' + fmt(cy) + ' L' + fmt(vp[0]) + ' ' + fmt(vp[1]));
    }
  }
  for (let i = 0; i < numPetals; i++) {
    const ang = rotOffset + (i + 0.5) * (360 / numPetals);
    const g = (lx, ly) => rot(cx + lx, cy + ly, cx, cy, ang);
    const R = radius * 0.64, W = radius * 0.42;
    const p0 = g(0, 0);
    const c1 = g(-W * 0.9, -R * 0.4), c2 = g(-W * 0.5, -R * 0.98), pt = g(0, -R);
    const c3 = g(W * 0.5, -R * 0.98), c4 = g(W * 0.9, -R * 0.4);
    innerPetals.push('M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
      ' C' + fmt(c1[0]) + ' ' + fmt(c1[1]) + ' ' + fmt(c2[0]) + ' ' + fmt(c2[1]) + ' ' + fmt(pt[0]) + ' ' + fmt(pt[1]) +
      ' C' + fmt(c3[0]) + ' ' + fmt(c3[1]) + ' ' + fmt(c4[0]) + ' ' + fmt(c4[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) + 'Z');
  }
  for (let i = 0; i < numPetals * 2; i++) {
    const ang = rotOffset + i * (360 / (numPetals * 2)) + 12;
    const sLen = radius * (i % 2 === 0 ? 0.42 : 0.34);
    const sp = rot(cx, cy - sLen, cx, cy, ang);
    stamens.push('M' + fmt(cx) + ' ' + fmt(cy) + ' L' + fmt(sp[0]) + ' ' + fmt(sp[1]));
    anthers.push([sp[0], sp[1], 1.15]);
  }
  return [outerPetals, innerPetals, petalVeins, stamens, anthers];
}
function makeRosebud(cx, cy, length, width, angleDeg) {
  const g = (lx, ly) => rot(cx + lx, cy + ly, cx, cy, angleDeg);
  const L = length, W = width;
  const p0 = g(0, 0);
  const c1 = g(-W * 0.85, -L * 0.3), c2 = g(-W * 0.5, -L * 0.85), pt = g(0, -L);
  const c3 = g(W * 0.5, -L * 0.85), c4 = g(W * 0.85, -L * 0.3);
  const budD = 'M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' C' + fmt(c1[0]) + ' ' + fmt(c1[1]) + ' ' + fmt(c2[0]) + ' ' + fmt(c2[1]) + ' ' + fmt(pt[0]) + ' ' + fmt(pt[1]) +
    ' C' + fmt(c3[0]) + ' ' + fmt(c3[1]) + ' ' + fmt(c4[0]) + ' ' + fmt(c4[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) + 'Z';
  const f1 = g(-W * 0.25, -L * 0.45), f2 = g(W * 0.12, -L * 0.92);
  const foldD = 'M' + fmt(p0[0]) + ' ' + fmt(p0[1]) + ' Q' + fmt(f1[0]) + ' ' + fmt(f1[1]) + ' ' + fmt(f2[0]) + ' ' + fmt(f2[1]);
  const sL1 = g(-W * 0.95, -L * 0.25), sL2 = g(-W * 0.55, -L * 0.72);
  const sR1 = g(W * 0.95, -L * 0.25), sR2 = g(W * 0.55, -L * 0.72);
  const sM = g(0, -L * 0.55);
  const calyxD = 'M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' Q' + fmt(sL1[0]) + ' ' + fmt(sL1[1]) + ' ' + fmt(sL2[0]) + ' ' + fmt(sL2[1]) +
    ' Q' + fmt(g(-W * 0.25, -L * 0.3)[0]) + ' ' + fmt(g(-W * 0.25, -L * 0.3)[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' M' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' Q' + fmt(sR1[0]) + ' ' + fmt(sR1[1]) + ' ' + fmt(sR2[0]) + ' ' + fmt(sR2[1]) +
    ' Q' + fmt(g(W * 0.25, -L * 0.3)[0]) + ' ' + fmt(g(W * 0.25, -L * 0.3)[1]) + ' ' + fmt(p0[0]) + ' ' + fmt(p0[1]) +
    ' M' + fmt(p0[0]) + ' ' + fmt(p0[1]) + ' L' + fmt(sM[0]) + ' ' + fmt(sM[1]);
  return [budD, foldD, calyxD];
}
function build02() {
  const segs = [
    [[88, 1188], [126, 1085], [52, 1005], [96, 900]],
    [[96, 900], [140, 795], [54, 725], [98, 620]],
    [[98, 620], [140, 515], [52, 445], [96, 340]],
    [[96, 340], [138, 235], [56, 155], [90, 38]]
  ];
  const [spineD, getX] = buildSpine(segs);
  const segs2 = [
    [[82, 1185], [50, 1090], [128, 1005], [88, 900]],
    [[88, 900], [48, 795], [130, 725], [88, 620]],
    [[88, 620], [48, 515], [128, 445], [88, 340]],
    [[88, 340], [50, 235], [122, 155], [90, 38]]
  ];
  const [spine2D] = buildSpine(segs2);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 1200" fill="none">',
    '<defs>',
    '  <linearGradient id="wfLeaf02" x1="0%" y1="0%" x2="100%" y2="100%">',
    '    <stop offset="0%" stop-color="#B3AE8E"/>',
    '    <stop offset="100%" stop-color="#878265"/>',
    '  </linearGradient>',
    '  <radialGradient id="petalOuter02" cx="50%" cy="50%" r="55%">',
    '    <stop offset="0%" stop-color="#C99E87"/>',
    '    <stop offset="70%" stop-color="#DFC6B0"/>',
    '    <stop offset="100%" stop-color="#EFE0D1"/>',
    '  </radialGradient>',
    '  <radialGradient id="petalInner02" cx="50%" cy="50%" r="55%">',
    '    <stop offset="0%" stop-color="#B8876E"/>',
    '    <stop offset="100%" stop-color="#DFC4AE"/>',
    '  </radialGradient>',
    '</defs>',
    '<path d="' + spine2D + '" stroke="#9A8F76" stroke-width="1.0" stroke-opacity="0.6" stroke-linecap="round"/>',
    '<path d="' + spineD + '" stroke="#7B7059" stroke-width="2.0" stroke-linecap="round" stroke-linejoin="round"/>'
  ];
  const petioles = [], leaves = [], leafVeins = [];
  const buds = [], budFolds = [], calyxes = [];
  const outerP = [], innerP = [], pVeins = [], stamens = [], anthers = [], centers = [];
  const leafNodes = [
    [1130, -36, -42, -1, 36, 15, -36],
    [1045, 40, -46, 1, 42, 18, 38],
    [930, -40, -48, -1, 42, 18, -38],
    [790, 40, -46, 1, 42, 18, 38],
    [675, -40, -48, -1, 42, 18, -38],
    [525, 40, -46, 1, 42, 18, 38],
    [405, -40, -46, -1, 42, 18, -38],
    [255, 38, -44, 1, 40, 17, 36],
    [145, -36, -42, -1, 38, 16, -34]
  ];
  for (const [sy, dx, dy, side, llen, lwid, lang] of leafNodes) {
    const sx = getX(sy);
    const bx = sx + dx, by = sy + dy;
    const c1x = sx + side * 12, c1y = sy - 14;
    const c2x = bx - side * 8, c2y = by + 14;
    petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' C' + fmt(c1x) + ' ' + fmt(c1y) + ' ' + fmt(c2x) + ' ' + fmt(c2y) + ' ' + fmt(bx) + ' ' + fmt(by));
    const [out, vn] = makeBotanicalLeaf(bx, by, llen, lwid, lang, -side * 0.15);
    leaves.push(out);
    leafVeins.push(vn);
    const [mx, my] = evalCubicBezier([sx, sy], [c1x, c1y], [c2x, c2y], [bx, by], 0.55);
    for (const sMult of [-1, 1]) {
      const [sOut, sVn] = makeBotanicalLeaf(mx, my, llen * 0.52, lwid * 0.52, lang + sMult * 36, 0.1 * sMult);
      leaves.push(sOut);
      leafVeins.push(sVn);
    }
  }
  const budNodes = [
    [1085, 28, -34, 1, 22, 11, 32],
    [835, -30, -36, -1, 24, 12, -34],
    [575, -28, -34, -1, 22, 11, -32],
    [305, 28, -34, 1, 22, 11, 32],
    [95, 26, -32, 1, 20, 10, 28]
  ];
  for (const [sy, dx, dy, side, blen, bwid, bang] of budNodes) {
    const sx = getX(sy);
    const bx = sx + dx, by = sy + dy;
    petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' Q' + fmt(sx + side * 14) + ' ' + fmt(sy - 16) + ' ' + fmt(bx) + ' ' + fmt(by));
    const [bd, fd, cd] = makeRosebud(bx, by, blen, bwid, bang);
    buds.push(bd);
    budFolds.push(fd);
    calyxes.push(cd);
  }
  const blossomNodes = [
    [980, -34, -30, -1, 21, 15],
    [730, -36, -32, -1, 23, 28],
    [465, -34, -30, -1, 22, 10],
    [195, -32, -28, -1, 20, 35],
    [38, 0, -6, 1, 19, 0]
  ];
  for (const [sy, dx, dy, side, rad, rotOff] of blossomNodes) {
    const sx = getX(sy);
    const fx = sx + dx, fy = sy + dy;
    if (Math.abs(dx) > 0) petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' Q' + fmt(sx + side * 15) + ' ' + fmt(sy - 18) + ' ' + fmt(fx) + ' ' + fmt(fy));
    const [op, ip, pv, st, an] = makeRosetteFlower(fx, fy, rad, 5, rotOff);
    outerP.push(...op);
    innerP.push(...ip);
    pVeins.push(...pv);
    stamens.push(...st);
    anthers.push(...an);
    centers.push([fx, fy, rad * 0.16]);
  }
  svg.push('<g stroke="#7B7059" stroke-width="1.35" stroke-linecap="round"><path d="' + petioles.join(' ') + '"/></g>');
  svg.push('<g fill="url(#wfLeaf02)" stroke="#6E644E" stroke-width="1.15" stroke-linejoin="round">');
  for (const p of leaves) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#5C5340" stroke-width="0.6" stroke-linecap="round" opacity="0.75"><path d="' + leafVeins.join(' ') + '"/></g>');
  svg.push('<g fill="url(#petalInner02)" stroke="#8C6754" stroke-width="1.15" stroke-linejoin="round">');
  for (const p of buds) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#8C6754" stroke-width="0.8" stroke-linecap="round"><path d="' + budFolds.join(' ') + '"/></g>');
  svg.push('<g fill="#878265" stroke="#6E644E" stroke-width="1.0" stroke-linejoin="round"><path d="' + calyxes.join(' ') + '"/></g>');
  svg.push('<g fill="url(#petalOuter02)" stroke="#9B7864" stroke-width="1.2" stroke-linejoin="round">');
  for (const p of outerP) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#9B7864" stroke-width="0.55" stroke-linecap="round" opacity="0.55"><path d="' + pVeins.join(' ') + '"/></g>');
  svg.push('<g fill="url(#petalInner02)" stroke="#8C6754" stroke-width="1.0" stroke-linejoin="round" opacity="0.92">');
  for (const p of innerP) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#7D5A47" stroke-width="0.75" stroke-linecap="round"><path d="' + stamens.join(' ') + '"/></g>');
  svg.push('<g fill="#D4AF6A" stroke="#7D5A47" stroke-width="0.6">');
  for (const [ax, ay, ar] of anthers) svg.push('  <circle cx="' + fmt(ax) + '" cy="' + fmt(ay) + '" r="' + fmt(ar) + '"/>');
  for (const [cxF, cyF, crF] of centers) svg.push('  <circle cx="' + fmt(cxF) + '" cy="' + fmt(cyF) + '" r="' + fmt(crF) + '" fill="#9B7864"/>');
  svg.push('</g>');
  svg.push('</svg>');
  return svg.join('\n');
}

// ---------------- 03 ivy margin ----------------
function makeIvyLeaf(cx, cy, scale, angleDeg) {
  const g = (lx, ly) => rot(cx + lx * scale, cy + ly * scale, cx, cy, angleDeg);
  const pBase = g(0, 0);
  const bLC1 = g(-0.22, 0.14), bLC2 = g(-0.62, 0.10), pBL = g(-0.72, -0.14);
  const s1C1 = g(-0.64, -0.26), pS1 = g(-0.48, -0.32);
  const mLC1 = g(-0.76, -0.44), mLC2 = g(-0.88, -0.68), pML = g(-0.82, -0.88);
  const s2C1 = g(-0.60, -0.84), pS2 = g(-0.38, -0.78);
  const apLC1 = g(-0.46, -1.12), apLC2 = g(-0.22, -1.48), pTip = g(0.0, -1.68);
  const apRC1 = g(0.22, -1.48), apRC2 = g(0.46, -1.12), pS3 = g(0.38, -0.78);
  const mRC1 = g(0.60, -0.84), pMR = g(0.82, -0.88);
  const mRC2 = g(0.88, -0.68), mRC3 = g(0.76, -0.44), pS4 = g(0.48, -0.32);
  const bRC1 = g(0.64, -0.26), pBR = g(0.72, -0.14);
  const bRC2 = g(0.62, 0.10), bRC3 = g(0.22, 0.14);
  const outline = ('M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) +
    ' C' + fmt(bLC1[0]) + ' ' + fmt(bLC1[1]) + ' ' + fmt(bLC2[0]) + ' ' + fmt(bLC2[1]) + ' ' + fmt(pBL[0]) + ' ' + fmt(pBL[1]) +
    ' Q' + fmt(s1C1[0]) + ' ' + fmt(s1C1[1]) + ' ' + fmt(pS1[0]) + ' ' + fmt(pS1[1]) +
    ' C' + fmt(mLC1[0]) + ' ' + fmt(mLC1[1]) + ' ' + fmt(mLC2[0]) + ' ' + fmt(mLC2[1]) + ' ' + fmt(pML[0]) + ' ' + fmt(pML[1]) +
    ' Q' + fmt(s2C1[0]) + ' ' + fmt(s2C1[1]) + ' ' + fmt(pS2[0]) + ' ' + fmt(pS2[1]) +
    ' C' + fmt(apLC1[0]) + ' ' + fmt(apLC1[1]) + ' ' + fmt(apLC2[0]) + ' ' + fmt(apLC2[1]) + ' ' + fmt(pTip[0]) + ' ' + fmt(pTip[1]) +
    ' C' + fmt(apRC1[0]) + ' ' + fmt(apRC1[1]) + ' ' + fmt(apRC2[0]) + ' ' + fmt(apRC2[1]) + ' ' + fmt(pS3[0]) + ' ' + fmt(pS3[1]) +
    ' Q' + fmt(mRC1[0]) + ' ' + fmt(mRC1[1]) + ' ' + fmt(pMR[0]) + ' ' + fmt(pMR[1]) +
    ' C' + fmt(mRC2[0]) + ' ' + fmt(mRC2[1]) + ' ' + fmt(mRC3[0]) + ' ' + fmt(mRC3[1]) + ' ' + fmt(pS4[0]) + ' ' + fmt(pS4[1]) +
    ' Q' + fmt(bRC1[0]) + ' ' + fmt(bRC1[1]) + ' ' + fmt(pBR[0]) + ' ' + fmt(pBR[1]) +
    ' C' + fmt(bRC2[0]) + ' ' + fmt(bRC2[1]) + ' ' + fmt(bRC3[0]) + ' ' + fmt(bRC3[1]) + ' ' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + 'Z');
  const vAp = g(0.0, -1.50), vML = g(-0.70, -0.78), vMR = g(0.70, -0.78);
  const vBL = g(-0.58, -0.12), vBR = g(0.58, -0.12);
  const svL1 = g(0, -0.65), svL2 = g(-0.26, -0.95);
  const svR1 = g(0, -0.65), svR2 = g(0.26, -0.95);
  const svL3 = g(0, -1.05), svL4 = g(-0.18, -1.28);
  const svR3 = g(0, -1.05), svR4 = g(0.18, -1.28);
  const veins = ('M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + ' L' + fmt(vAp[0]) + ' ' + fmt(vAp[1]) +
    ' M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + ' L' + fmt(vML[0]) + ' ' + fmt(vML[1]) +
    ' M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + ' L' + fmt(vMR[0]) + ' ' + fmt(vMR[1]) +
    ' M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + ' L' + fmt(vBL[0]) + ' ' + fmt(vBL[1]) +
    ' M' + fmt(pBase[0]) + ' ' + fmt(pBase[1]) + ' L' + fmt(vBR[0]) + ' ' + fmt(vBR[1]) +
    ' M' + fmt(svL1[0]) + ' ' + fmt(svL1[1]) + ' L' + fmt(svL2[0]) + ' ' + fmt(svL2[1]) +
    ' M' + fmt(svR1[0]) + ' ' + fmt(svR1[1]) + ' L' + fmt(svR2[0]) + ' ' + fmt(svR2[1]) +
    ' M' + fmt(svL3[0]) + ' ' + fmt(svL3[1]) + ' L' + fmt(svL4[0]) + ' ' + fmt(svL4[1]) +
    ' M' + fmt(svR3[0]) + ' ' + fmt(svR3[1]) + ' L' + fmt(svR4[0]) + ' ' + fmt(svR4[1]));
  return [outline, veins];
}
function makeIvyUmbel(cx, cy, radius, angleDeg) {
  const peds = [], berries = [];
  for (const deg of [-48, -24, 0, 24, 48]) {
    const rLen = radius * (Math.abs(deg) === 24 ? 0.95 : (deg === 0 ? 1.05 : 0.82));
    const [bx, by] = rot(cx, cy - rLen, cx, cy, angleDeg + deg);
    peds.push('M' + fmt(cx) + ' ' + fmt(cy) + ' L' + fmt(bx) + ' ' + fmt(by));
    berries.push([bx, by, 2.3]);
  }
  return [peds.join(' '), berries];
}
function build03() {
  const segs = [
    [[92, 1188], [40, 1080], [132, 1000], [84, 895]],
    [[84, 895], [38, 790], [134, 720], [83, 610]],
    [[83, 610], [38, 500], [132, 425], [82, 315]],
    [[82, 315], [44, 220], [118, 130], [89, 34]]
  ];
  const [spineD, getX] = buildSpine(segs);
  const segs2 = [
    [[84, 1185], [128, 1085], [52, 1000], [92, 895]],
    [[92, 895], [130, 790], [50, 720], [91, 610]],
    [[91, 610], [130, 500], [52, 425], [90, 315]],
    [[90, 315], [126, 220], [62, 130], [89, 34]]
  ];
  const [spine2D] = buildSpine(segs2);
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 1200" fill="none">',
    '<defs>',
    '  <linearGradient id="ivyLeafMain03" x1="0%" y1="0%" x2="100%" y2="100%">',
    '    <stop offset="0%" stop-color="#98A882"/>',
    '    <stop offset="100%" stop-color="#6B7A58"/>',
    '  </linearGradient>',
    '  <linearGradient id="ivyLeafSub03" x1="0%" y1="100%" x2="100%" y2="0%">',
    '    <stop offset="0%" stop-color="#B0BE9B" stop-opacity="0.85"/>',
    '    <stop offset="100%" stop-color="#7F8E6B" stop-opacity="0.92"/>',
    '  </linearGradient>',
    '</defs>',
    '<path d="' + spine2D + '" stroke="#839170" stroke-width="1.05" stroke-opacity="0.65" stroke-linecap="round"/>',
    '<path d="' + spineD + '" stroke="#5A684C" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>'
  ];
  const nodes = [
    [1135, 30, -30, 1, 16, 36, false],
    [1075, -36, -36, -1, 23, -38, true],
    [1005, 38, -38, 1, 23, 38, true],
    [925, -28, -28, -1, 16, -32, false],
    [855, -38, -36, -1, 24, -40, true],
    [770, 38, -38, 1, 23, 38, true],
    [690, -28, -28, -1, 16, -34, false],
    [625, 30, -30, 1, 17, 34, false],
    [565, -38, -36, -1, 24, -38, true],
    [485, 38, -38, 1, 23, 38, true],
    [405, -28, -28, -1, 16, -32, false],
    [340, 30, -30, 1, 17, 34, false],
    [275, -36, -36, -1, 22, -38, true],
    [190, 36, -36, 1, 21, 36, true],
    [115, -28, -28, -1, 17, -34, false]
  ];
  const petioles = [], tendrils = [], mainLeaves = [], subLeaves = [], veins = [], umbelPeds = [], berries = [];
  for (const [sy, dx, dy, side, sc, ang, isMain] of nodes) {
    const sx = getX(sy);
    const bx = sx + dx, by = sy + dy;
    petioles.push('M' + fmt(sx) + ' ' + fmt(sy) + ' Q' + fmt(sx + side * 16) + ' ' + fmt(sy - 12) + ' ' + fmt(bx) + ' ' + fmt(by));
    const [out, vn] = makeIvyLeaf(bx, by, sc, ang);
    if (isMain) {
      mainLeaves.push(out);
      if (sy === 1075 || sy === 770 || sy === 485 || sy === 190) {
        const [uped, uber] = makeIvyUmbel(sx, sy, 18, -side * 36);
        umbelPeds.push(uped);
        berries.push(...uber);
      } else {
        tendrils.push(makeBezierTendril(sx, sy, 20, -side * 32, -side));
      }
    } else {
      subLeaves.push(out);
    }
    veins.push(vn);
  }
  const topX = getX(34);
  const [tout, tvn] = makeIvyLeaf(topX, 38, 18, 0);
  mainLeaves.push(tout);
  veins.push(tvn);
  svg.push('<g stroke="#68765A" stroke-width="1.4" stroke-linecap="round"><path d="' + petioles.join(' ') + '"/></g>');
  svg.push('<g stroke="#7A8868" stroke-width="1.0" stroke-linecap="round" opacity="0.85"><path d="' + tendrils.join(' ') + '"/></g>');
  svg.push('<g stroke="#68765A" stroke-width="1.0" stroke-linecap="round"><path d="' + umbelPeds.join(' ') + '"/></g>');
  svg.push('<g fill="url(#ivyLeafSub03)" stroke="#68765A" stroke-width="1.1" stroke-linejoin="round">');
  for (const p of subLeaves) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g fill="url(#ivyLeafMain03)" stroke="#5A684C" stroke-width="1.3" stroke-linejoin="round">');
  for (const p of mainLeaves) svg.push('  <path d="' + p + '"/>');
  svg.push('</g>');
  svg.push('<g stroke="#48543B" stroke-width="0.65" stroke-linecap="round" opacity="0.80"><path d="' + veins.join(' ') + '"/></g>');
  svg.push('<g fill="#5E6B56" stroke="#48543B" stroke-width="0.85">');
  for (const [bx, by, br] of berries) svg.push('  <circle cx="' + fmt(bx) + '" cy="' + fmt(by) + '" r="' + fmt(br) + '"/>');
  svg.push('</g>');
  svg.push('</svg>');
  return svg.join('\n');
}

fs.writeFileSync(path + '01_delicate_climbing_vine.svg', build01());
fs.writeFileSync(path + '02_wildflower_vine.svg', build02());
fs.writeFileSync(path + '03_ivy_margin.svg', build03());
for (const f of fs.readdirSync(path)) console.log(f, Math.round(fs.statSync(path + f).size / 1024) + 'KB');
console.log('generated');
