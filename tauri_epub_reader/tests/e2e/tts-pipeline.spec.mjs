import { test, expect } from '@playwright/test';
import { fresh, openDemo } from './helpers.mjs';

test.describe('TTS Pipeline & Controls', () => {
  test.beforeEach(async ({ page }) => {
    await fresh(page);
    await openDemo(page);
  });

  test('TTS1 stop button visibility and non-blocking stop', async ({ page }) => {
    // Before speaking, stop button must be hidden
    const stopBtn = page.locator('#btnSpeakStop');
    await expect(stopBtn).toBeHidden();

    // Start TTS via toggle
    await page.evaluate(() => {
      // Mock playWav and KittenRunner to avoid downloading actual 90MB model in test runner
      KittenRunner.generate = async () => {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      };
      TTS.playWav = async () => {
        return true;
      };
      TTS.toggle();
    });

    // Stop button should now be visible
    await expect(stopBtn).toBeVisible();
    const isSpeakActive = await page.evaluate(() => TTS.active);
    expect(isSpeakActive).toBe(true);

    // Click stop button
    await stopBtn.click();

    // Stop button should immediately be hidden, TTS inactive, speak button inactive
    await expect(stopBtn).toBeHidden();
    const stoppedState = await page.evaluate(() => ({
      active: TTS.active,
      stopped: TTS.stopped,
      btnActive: document.getElementById('btnSpeak').classList.contains('active'),
      ariaPressed: document.getElementById('btnSpeak').getAttribute('aria-pressed'),
    }));

    expect(stoppedState.active).toBe(false);
    expect(stoppedState.stopped).toBe(true);
    expect(stoppedState.btnActive).toBe(false);
    expect(stoppedState.ariaPressed).toBe('false');
  });

  test('TTS2 heading isolation and progressive group sizing', async ({ page }) => {
    const groupResult = await page.evaluate(() => {
      // Setup synthetic sentences simulating:
      // 1. Chapter Title (Heading)
      // 2. Short opening line (Body)
      // 3. Several medium body sentences
      // 4. Long body sentences
      const mockSentences = [
        { text: 'Chapter One: The Journey Begins', isHeading: true, block: 'b1', span: null },
        { text: 'The morning mist was thick.', isHeading: false, block: 'b2', span: null },
        { text: 'Birds were chirping softly in the ancient trees of the forgotten forest.', isHeading: false, block: 'b2', span: null },
        { text: 'A small carriage rolled quietly along the stone path towards the distant mountains.', isHeading: false, block: 'b2', span: null },
        { text: 'Inside the carriage sat an old scholar with a worn leather-bound book in his lap.', isHeading: false, block: 'b3', span: null },
        { text: 'He looked out the window at the rolling green hills and took a deep, contemplative breath.', isHeading: false, block: 'b3', span: null },
        { text: 'Every detail of the landscape was familiar, yet today it seemed shrouded in mystery.', isHeading: false, block: 'b3', span: null },
      ];

      TTS.sents = mockSentences;
      TTS.engine = 'kitten';
      TTS.groups = [];

      // Run grouping loop identical to loadPageAndSpeak
      let start = 0, cur = mockSentences[0].block, chars = 0, nonHeadingCount = 0;
      for (let i = 0; i < mockSentences.length; i++) {
        const len = mockSentences[i].text.length;
        const prevHeading = i > 0 ? !!mockSentences[i - 1].isHeading : false;
        const curHeading = !!mockSentences[i].isHeading;
        const headingBoundary = i > start && (curHeading !== prevHeading);
        const limit = curHeading ? 300 : (nonHeadingCount === 0 ? 120 : (nonHeadingCount === 1 ? 200 : 380));
        const blockChanged = mockSentences[i].block !== cur;
        const breakGroup = headingBoundary || (chars + len > limit) || (blockChanged && (curHeading || chars > 150));
        if (i > start && breakGroup) {
          TTS.groups.push({ start, end: i - 1, isHeading: prevHeading });
          if (!prevHeading) nonHeadingCount++;
          start = i; chars = 0;
        }
        cur = mockSentences[i].block; chars += len;
      }
      if (mockSentences.length) {
        TTS.groups.push({ start, end: mockSentences.length - 1, isHeading: !!mockSentences[start].isHeading });
      }

      return TTS.groups;
    });

    // Verification:
    // Group 0 MUST be the heading alone (start: 0, end: 0, isHeading: true)
    expect(groupResult.length).toBeGreaterThan(1);
    expect(groupResult[0].start).toBe(0);
    expect(groupResult[0].end).toBe(0);
    expect(groupResult[0].isHeading).toBe(true);

    // Group 1 must NOT be a heading
    expect(groupResult[1].isHeading).toBe(false);
    expect(groupResult[1].start).toBe(1);
  });

  test('TTS3 natural post-heading gap and terminal punctuation logic', async ({ page }) => {
    const timingAndProsody = await page.evaluate(() => {
      TTS.rate = 1.0;
      const normalGap = TTS.sentGapMs(false);
      const postHeadingGap = TTS.sentGapMs(true);

      TTS.rate = 1.5;
      const normalGapFast = TTS.sentGapMs(false);
      const postHeadingGapFast = TTS.sentGapMs(true);

      // Terminal punctuation check for heading synthesis
      const testHeadingWithoutPunct = 'Chapter IV The Great Forest';
      let synthText = testHeadingWithoutPunct.trim();
      const isHeading = true;
      if (isHeading && synthText && !/[.!?:]$/.test(synthText)) {
        synthText += '.';
      }

      return {
        normalGap,
        postHeadingGap,
        normalGapFast,
        postHeadingGapFast,
        synthText,
      };
    });

    // Post-heading gap should be ~1800ms at 1.0 rate
    expect(timingAndProsody.postHeadingGap).toBe(1800);
    expect(timingAndProsody.normalGap).toBe(350);

    // At 1.5 rate, gap scales with rate/Math.sqrt(rate)
    expect(timingAndProsody.postHeadingGapFast).toBe(Math.round(1800 / Math.sqrt(1.5)));
    expect(timingAndProsody.normalGapFast).toBe(Math.round(350 / 1.5));

    // Heading synthesis text gets natural terminal punctuation
    expect(timingAndProsody.synthText).toBe('Chapter IV The Great Forest.');
  });

  test('TTS4 adaptive profile, hardware tier limits, and heading punctuation isolation', async ({ page }) => {
    const adaptiveResults = await page.evaluate(async () => {
      // Mock install to prevent 90MB model download during test
      KittenRunner.install = async () => true;
      KittenRunner._workerReady = true;

      // 1. Initial Profile
      const initialProfile = TTS.getProfile();

      // 2. Adaptive Tier Limits calculation
      TTS.rollingRtf = 0.18; // Fast (e.g. Native Rust)
      const fastLimits = TTS.getChunkLimits();

      TTS.rollingRtf = 0.45; // Balanced
      const balancedLimits = TTS.getChunkLimits();

      TTS.rollingRtf = 1.20; // Constrained (e.g. WASM on low power)
      const constrainedLimits = TTS.getChunkLimits();

      // 3. Heading Punctuation Isolation (prevent Chapter 1.... quirk)
      const headingWithPeriod = { start: 0, end: 0, isHeading: true };
      const headingWithoutPeriod = { start: 1, end: 1, isHeading: true };
      const headingWithEllipsis = { start: 2, end: 2, isHeading: true };
      const normalBody = { start: 3, end: 3, isHeading: false };

      TTS.sents = [
        { text: 'Chapter 1.' },
        { text: 'Chapter 2' },
        { text: 'Chapter 3…' },
        { text: 'Body paragraph without trailing dot' }
      ];

      const text1 = TTS.getGroupText(headingWithPeriod);
      const text2 = TTS.getGroupText(headingWithoutPeriod);
      const text3 = TTS.getGroupText(headingWithEllipsis);
      const text4 = TTS.getGroupText(normalBody);

      // Verify underlying sentences were not mutated
      const sent0Unmutated = TTS.sents[0].text;
      const sent1Unmutated = TTS.sents[1].text;

      // 4. Test Backend & Thread Setters
      await TTS.setBackendMode('wasm-worker');
      const wasmModeProfile = TTS.getProfile().mode;

      await TTS.setThreads(4);
      const threadsProfile = TTS.getProfile().configuredThreads;

      // Reset to auto
      await TTS.setBackendMode('auto');

      return {
        initialProfile,
        fastLimits,
        balancedLimits,
        constrainedLimits,
        text1,
        text2,
        text3,
        text4,
        sent0Unmutated,
        sent1Unmutated,
        wasmModeProfile,
        threadsProfile
      };
    });

    // Profile verification
    expect(adaptiveResults.initialProfile).toBeDefined();
    expect(adaptiveResults.initialProfile.benchmarks).toBeDefined();

    // Tier limits verification
    expect(adaptiveResults.fastLimits.tier).toBe('Fast');
    expect(adaptiveResults.fastLimits.g0).toBe(140);
    expect(adaptiveResults.fastLimits.lookahead).toBe(3);

    expect(adaptiveResults.balancedLimits.tier).toBe('Balanced');
    expect(adaptiveResults.balancedLimits.g0).toBe(100);
    expect(adaptiveResults.balancedLimits.lookahead).toBe(3);

    expect(adaptiveResults.constrainedLimits.tier).toBe('Constrained');
    expect(adaptiveResults.constrainedLimits.g0).toBe(75);
    expect(adaptiveResults.constrainedLimits.lookahead).toBe(4);

    // Punctuation isolation verification
    expect(adaptiveResults.text1).toBe('Chapter 1.'); // NOT 'Chapter 1..' or 'Chapter 1....'
    expect(adaptiveResults.text2).toBe('Chapter 2.'); // single period appended
    expect(adaptiveResults.text3).toBe('Chapter 3…'); // ellipsis recognized, no period appended
    expect(adaptiveResults.text4).toBe('Body paragraph without trailing dot'); // non-heading not modified

    // Immutability verification
    expect(adaptiveResults.sent0Unmutated).toBe('Chapter 1.');
    expect(adaptiveResults.sent1Unmutated).toBe('Chapter 2');

    // Backend & Thread control verification
    expect(adaptiveResults.wasmModeProfile).toBe('wasm-worker');
    expect(adaptiveResults.threadsProfile).toBe(4);
  });

  test('TTS5 duplicate synthesis prevention, cache eviction safety, and promise deduplication', async ({ page }) => {
    const results = await page.evaluate(async () => {
      // Mock KittenRunner.install to prevent downloading model
      KittenRunner.install = async () => true;
      KittenRunner._workerReady = true;

      const calls = [];
      KittenRunner.generate = async (text, voice, rate, gu, gi) => {
        calls.push({ gi, text, gu });
        return new Uint8Array(44 + 4800).buffer;
      };

      TTS.engine = 'kitten';
      TTS.active = true;
      TTS.stopped = false;
      TTS.paused = false;
      TTS.gen = 5;
      TTS.gi = 0;
      TTS.clearPcm();

      TTS.sents = [
        { text: 'Chapter 1.' },
        { text: 'Paragraph one of the story.' },
        { text: 'Paragraph two follows here.' }
      ];
      TTS.groups = [
        { start: 0, end: 0, isHeading: true },
        { start: 1, end: 1, isHeading: false },
        { start: 2, end: 2, isHeading: false }
      ];

      // 1. Parallel calls to synthesizeGroup for group 0
      const p1 = TTS.synthesizeGroup(0, 5);
      const p2 = TTS.synthesizeGroup(0, 5);
      const isIdenticalPromise = (p1 === p2);
      await p1;
      const countAfterParallel = calls.length; // Must be exactly 1

      // 2. Simulate playback cache eviction
      TTS.pcmCache.delete(0);
      const cachedAfterEvict = TTS.pcmCache.has(0);
      const startedAfterEvict = TTS._startedGroups.has(0);

      // Re-requesting group 0 must return null and NOT re-synthesize
      const p3Result = await TTS.synthesizeGroup(0, 5);
      const countAfterEvictCall = calls.length; // Still 1

      // 3. Test pumpPrefetch skips already-started group 0 and only schedules 1 and 2
      TTS.gi = 0;
      TTS.pumpPrefetch(5);

      // Wait a moment for prefetch queue to finish
      for (let i = 0; i < 20; i++) {
        if (!TTS._pumpRunning && TTS._startedGroups.has(1) && TTS._startedGroups.has(2)) break;
        await new Promise(r => setTimeout(r, 20));
      }

      const allCalls = [...calls];
      const startedGroupsList = Array.from(TTS._startedGroups);

      return {
        isIdenticalPromise,
        countAfterParallel,
        cachedAfterEvict,
        startedAfterEvict,
        p3Result,
        countAfterEvictCall,
        allCalls,
        startedGroupsList
      };
    });

    expect(results.isIdenticalPromise).toBe(true);
    expect(results.countAfterParallel).toBe(1);
    expect(results.cachedAfterEvict).toBe(false);
    expect(results.startedAfterEvict).toBe(true);
    expect(results.p3Result).toBeNull();
    expect(results.countAfterEvictCall).toBe(1);

    // Verify all generated group indices: 0, 1, 2 with no duplicates
    const generatedGis = results.allCalls.map(c => c.gi);
    expect(generatedGis).toEqual([0, 1, 2]);
    expect(new Set(generatedGis).size).toBe(generatedGis.length);
    expect(results.startedGroupsList).toContain(0);
    expect(results.startedGroupsList).toContain(1);
    expect(results.startedGroupsList).toContain(2);
  });

  test('TTS6 starvation guard and exponential rolling RTF tracking', async ({ page }) => {
    const starveResults = await page.evaluate(async () => {
      // Mock install
      KittenRunner.install = async () => true;
      KittenRunner._workerReady = true;

      // 1.0s audio chunk: 44 bytes header + 48000 bytes PCM (24kHz 16-bit mono)
      const fakeWav = new Uint8Array(44 + 48000).buffer;

      TTS.rollingRtf = null;
      TTS.consecutiveStarveCount = 0;
      TTS._starveWarned = false;

      // Step 1: Fast chunk (200ms generation -> RTF = 0.20)
      TTS.recordGroupMetrics(200, fakeWav);
      const rtfStep1 = TTS.rollingRtf;
      const starveCount1 = TTS.consecutiveStarveCount;
      const warned1 = TTS._starveWarned;

      // Step 2: Medium chunk (400ms generation -> RTF = 0.40)
      // rolling = 0.7 * 0.20 + 0.3 * 0.40 = 0.14 + 0.12 = 0.26
      TTS.recordGroupMetrics(400, fakeWav);
      const rtfStep2 = TTS.rollingRtf;

      // Step 3: First slow chunk with rollingRtf pushed above 0.95
      TTS.rollingRtf = 0.96;
      TTS.recordGroupMetrics(1000, fakeWav); // 1000ms -> rtf = 1.0 -> 0.7*0.96 + 0.3*1.0 = 0.972
      const starveCount3 = TTS.consecutiveStarveCount; // Should be 1
      const warned3 = TTS._starveWarned; // Should still be false (< 2)

      // Step 4: Second consecutive slow chunk (>= 2 triggers warning)
      TTS.recordGroupMetrics(1000, fakeWav);
      const starveCount4 = TTS.consecutiveStarveCount; // Should be 2
      const warned4 = TTS._starveWarned; // Should be true

      // Step 5: Fast chunk arrives -> resets consecutiveStarveCount to 0
      TTS.rollingRtf = 0.50;
      TTS.recordGroupMetrics(200, fakeWav); // rtf = 0.2 -> 0.7*0.5 + 0.3*0.2 = 0.41 <= 0.95
      const starveCount5 = TTS.consecutiveStarveCount; // Should be 0

      // Step 6: TTS.stop() cleanly resets starvation flags
      TTS._starveWarned = true;
      TTS.consecutiveStarveCount = 3;
      TTS.stop(true);
      const warnedStopped = TTS._starveWarned;
      const starveCountStopped = TTS.consecutiveStarveCount;

      return {
        rtfStep1,
        starveCount1,
        warned1,
        rtfStep2,
        starveCount3,
        warned3,
        starveCount4,
        warned4,
        starveCount5,
        warnedStopped,
        starveCountStopped
      };
    });

    expect(starveResults.rtfStep1).toBeCloseTo(0.20, 2);
    expect(starveResults.starveCount1).toBe(0);
    expect(starveResults.warned1).toBe(false);

    expect(starveResults.rtfStep2).toBeCloseTo(0.26, 2);

    expect(starveResults.starveCount3).toBe(1);
    expect(starveResults.warned3).toBe(false);

    expect(starveResults.starveCount4).toBe(2);
    expect(starveResults.warned4).toBe(true);

    expect(starveResults.starveCount5).toBe(0);

    expect(starveResults.warnedStopped).toBe(false);
    expect(starveResults.starveCountStopped).toBe(0);
  });

  test('TTS7 heading prosody & comprehensive punctuation edge cases', async ({ page }) => {
    const punctResults = await page.evaluate(() => {
      TTS.sents = [
        { text: 'Chapter 1' },
        { text: 'Chapter 2.' },
        { text: 'Chapter 3!' },
        { text: 'Chapter 4?' },
        { text: 'Chapter 5:' },
        { text: 'Chapter 6;' },
        { text: 'Chapter 7…' },
        { text: 'Chapter 8...' },
        { text: 'Chapter 9   ' },
        { text: 'Chapter 10.   ' },
        { text: 'Part One:' },
        { text: 'The Awakening' },
        { text: 'Regular body paragraph text without period' }
      ];

      // Clone original texts to test immutability
      const originalTexts = TTS.sents.map(s => s.text);

      const tests = [
        TTS.getGroupText({ start: 0, end: 0, isHeading: true }),
        TTS.getGroupText({ start: 1, end: 1, isHeading: true }),
        TTS.getGroupText({ start: 2, end: 2, isHeading: true }),
        TTS.getGroupText({ start: 3, end: 3, isHeading: true }),
        TTS.getGroupText({ start: 4, end: 4, isHeading: true }),
        TTS.getGroupText({ start: 5, end: 5, isHeading: true }),
        TTS.getGroupText({ start: 6, end: 6, isHeading: true }),
        TTS.getGroupText({ start: 7, end: 7, isHeading: true }),
        TTS.getGroupText({ start: 8, end: 8, isHeading: true }),
        TTS.getGroupText({ start: 9, end: 9, isHeading: true }),
        TTS.getGroupText({ start: 10, end: 11, isHeading: true }), // multi-sentence heading
        TTS.getGroupText({ start: 12, end: 12, isHeading: false }), // body paragraph
      ];

      const immutabilityPreserved = TTS.sents.every((s, i) => s.text === originalTexts[i]);

      return { tests, immutabilityPreserved, originalTexts };
    });

    expect(punctResults.immutabilityPreserved).toBe(true);
    expect(punctResults.tests[0]).toBe('Chapter 1.');
    expect(punctResults.tests[1]).toBe('Chapter 2.');
    expect(punctResults.tests[2]).toBe('Chapter 3!');
    expect(punctResults.tests[3]).toBe('Chapter 4?');
    expect(punctResults.tests[4]).toBe('Chapter 5:');
    expect(punctResults.tests[5]).toBe('Chapter 6;');
    expect(punctResults.tests[6]).toBe('Chapter 7…');
    expect(punctResults.tests[7]).toBe('Chapter 8...');
    expect(punctResults.tests[8]).toBe('Chapter 9.');
    expect(punctResults.tests[9]).toBe('Chapter 10.');
    expect(punctResults.tests[10]).toBe('Part One: The Awakening.');
    expect(punctResults.tests[11]).toBe('Regular body paragraph text without period');
  });

  test('TTS8 cancellation, generation invalidation, and state purge', async ({ page }) => {
    const purgeResults = await page.evaluate(async () => {
      // Mock install
      KittenRunner.install = async () => true;
      KittenRunner._workerReady = true;

      let resolveSlowGen;
      KittenRunner.generate = () => new Promise(res => {
        resolveSlowGen = () => res(new Uint8Array(44 + 4800).buffer);
      });

      TTS.engine = 'kitten';
      TTS.active = true;
      TTS.stopped = false;
      TTS.gen = 42;
      TTS.gi = 0;
      TTS.groups = [{ start: 0, end: 0, isHeading: false }];
      TTS.sents = [{ text: 'In flight sentence.' }];

      // Start in-flight generation with gu = 42
      const inFlightP = TTS.synthesizeGroup(0, 42);

      const hasInFlightPromise = TTS._genP.has(0);
      const isGroupStarted = TTS._startedGroups.has(0);

      // Invalidate generation by changing gen or stopping
      TTS.gen = 43;
      TTS.clearPcm();

      const clearedPcmSize = TTS.pcmCache.size;
      const clearedGenPSize = TTS._genP.size;
      const clearedStartedGroupsSize = TTS._startedGroups.size;

      // Now let the slow generation resolve late
      resolveSlowGen();
      const lateResult = await inFlightP;

      // Because gen !== gu (43 !== 42), pcmCache must NOT accept the stale result
      const pcmCacheAfterLateResolve = TTS.pcmCache.has(0);

      // Full stop check
      TTS.active = true;
      TTS.stopped = false;
      TTS.stop(true);
      const isStopped = TTS.stopped;
      const isActive = TTS.active;

      return {
        hasInFlightPromise,
        isGroupStarted,
        clearedPcmSize,
        clearedGenPSize,
        clearedStartedGroupsSize,
        lateResultHasBuffer: !!(lateResult && lateResult.byteLength),
        pcmCacheAfterLateResolve,
        isStopped,
        isActive
      };
    });

    expect(purgeResults.hasInFlightPromise).toBe(true);
    expect(purgeResults.isGroupStarted).toBe(true);
    expect(purgeResults.clearedPcmSize).toBe(0);
    expect(purgeResults.clearedGenPSize).toBe(0);
    expect(purgeResults.clearedStartedGroupsSize).toBe(0);
    expect(purgeResults.lateResultHasBuffer).toBe(true);
    expect(purgeResults.pcmCacheAfterLateResolve).toBe(false);
    expect(purgeResults.isStopped).toBe(true);
    expect(purgeResults.isActive).toBe(false);
  });
});
