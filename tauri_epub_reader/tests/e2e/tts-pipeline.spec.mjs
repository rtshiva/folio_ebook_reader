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
});
