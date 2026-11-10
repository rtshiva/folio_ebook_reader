// ESLint flat config — static analysis gate for Folio Reader.
// See docs/CODE_QUALITY.md for the bug-class -> rule mapping.
//
// The whole app lives in one inline <script> inside src/index.html;
// eslint-plugin-html extracts and lints it. No formatting rules here:
// this config only enforces correctness, pinning classes of bugs found
// in fix cycles 16-33 (null guards, leaked listeners, strict equality,
// fallthroughs, shadowed state) without reformatting existing code.
import html from 'eslint-plugin-html';
import globals from 'globals';
import security from 'eslint-plugin-security';

const htmlScriptRules = {
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'script',
    globals: {
      ...globals.browser,
      // vendor bundles loaded via <script src> (src/vendor/)
      ePub: 'readonly',
      JSZip: 'readonly',
      // CSS Custom Highlight API (present in WebView2/Chromium; the call
      // site already guards with typeof checks for older engines)
      Highlight: 'readonly',
    },
  },
  rules: {
    // --- Reference / scope safety -------------------------------------
    // no-undef catches typos in identifiers and calls across the single
    // script scope; no-redeclare guards the big flat namespace (the
    // double-declared addGrain trap found on first enable).
    'no-undef': 'error',
    'no-redeclare': 'error',
    'no-shadow': ['warn', { builtinGlobals: false, hoist: 'functions' }],
    // Off: the app is one flat script where functions legitimately
    // reference module objects declared further down at call time.
    'no-use-before-define': 'off',

    // --- Equality / comparison pitfalls -------------------------------
    // Loose == on user/book data hid several guard bugs (cycles 26-28).
    'eqeqeq': ['error', 'allow-null'],
    'no-self-compare': 'error',
    'no-eq-null': 'off', // covered by eqeqeq allow-null
    'use-isnan': 'error',
    'valid-typeof': ['error', { requireStringLiterals: true }],
    'no-unsafe-negation': 'error',
    'no-unsafe-optional-chaining': 'error',

    // --- Control flow ---------------------------------------------------
    'no-fallthrough': 'error',
    'no-unreachable': 'error',
    'no-cond-assign': ['error', 'except-parens'],
    'no-constant-condition': ['error', { checkLoops: false }],
    'for-direction': 'error',
    'getter-return': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-duplicate-case': 'error',
    'guard-for-in': 'error',

    // --- Dangerous patterns --------------------------------------------
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-proto': 'error',
    'no-iterator': 'error',
    'no-with': 'error',
    'no-delete-var': 'error',
    'no-octal': 'error',

    // --- Housekeeping (warn-level: mass of legacy code) ----------------
    // Unused vars often flag listeners/timers that were created but never
    // torn down (the cycle-29 TTS leak shape). Kept at warn so the gate
    // stays useful instead of forcing a 7000-line cleanup.
    'no-unused-vars': ['warn', {
      args: 'after-used',
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
    }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-extra-boolean-cast': 'warn',
    'no-sparse-arrays': 'error',
    'no-unexpected-multiline': 'error',
    'no-loss-of-precision': 'error',
    'no-async-promise-executor': 'error',
    'no-await-in-loop': 'warn',
    'require-atomic-updates': 'off', // too noisy for the turn-queue code
    'no-inner-declarations': 'warn',
    'no-unused-expressions': ['warn', { allowTernary: true, allowShortCircuit: true }],
  },
};

export default [
  { ignores: ['node_modules/**', 'src-tauri/target/**', 'tests/e2e/artifacts/**', 'tests/manual/**'] },

  // The shipped app: one inline <script> in src/index.html
  {
    files: ['src/**/*.html'],
    plugins: { html },
    settings: {
      'html/javascript-mimes': ['text/javascript'],
    },
    ...htmlScriptRules,
  },

  // Static scans, configs, and e2e specs (Node / Playwright)
  {
    files: ['tests/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...htmlScriptRules.rules,
      'no-undef': 'error',
      'no-console': 'off',
    },
  },

  {
    plugins: { security },
    rules: {
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-unsafe-regex': 'warn',
      'security/detect-buffer-noassert': 'warn',
      'security/detect-eval-with-expression': 'error',
      'security/detect-no-csrf-before-method-override': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'warn',
    },
  },

  // E2E test specs pass client-side functions to page.evaluate() which
  // legitimately reference app globals (state, LocEngine, Highlights, etc.)
  {
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        // Common app globals queried inside page.evaluate:
        state: 'readonly',
        settings: 'readonly',
        StoreKV: 'readonly',
        LocEngine: 'readonly',
        Highlights: 'readonly',
        TTS: 'readonly',
        CmdPalette: 'readonly',
        EdgeStacks: 'readonly',
        BookStorage: 'readonly',
        AutoScroll: 'readonly',
        DictCache: 'readonly',
        Footnotes: 'readonly',
        JSZip: 'readonly',
        Lightbox: 'readonly',
        NavHistory: 'readonly',
        PAGE_ORN: 'readonly',
        PageSurfacePool: 'readonly',
        PageTurnCompositor: 'readonly',
        PageTurnConfig: 'readonly',
        Ribbon: 'readonly',
        VocabLog: 'readonly',
        _effectivePace: 'readonly',
        _paceHistory: 'readonly',
        applySpread: 'readonly',
        applyTheme: 'readonly',
        applyWarmth: 'readonly',
        autoThemeTick: 'readonly',
        buildCSS: 'readonly',
        chNavIdx: 'readonly',
        closePanels: 'readonly',
        createSnapBox: 'readonly',
        dayKey: 'readonly',
        ePub: 'readonly',
        effectiveFx: 'readonly',
        el: 'readonly',
        ensureEpubUrlPatched: 'readonly',
        getActiveTitle: 'readonly',
        getEffectivePace: 'readonly',
        goHome: 'readonly',
        hideChrome: 'readonly',
        hideLoader: 'readonly',
        hideSelBar: 'readonly',
        idleBudgetMs: 'readonly',
        isSafeImageUrl: 'readonly',
        jumpToTocIndex: 'readonly',
        loadFile: 'readonly',
        loadPerBookType: 'readonly',
        openBuffer: 'readonly',
        openEpubPath: 'readonly',
        openSearch: 'readonly',
        pageCache: 'readonly',
        pageOrnVariant: 'readonly',
        railSeek: 'readonly',
        relayout: 'readonly',
        renderBookmarks: 'readonly',
        renderRecentShelf: 'readonly',
        renderSearchResults: 'readonly',
        resumeReading: 'readonly',
        sanitizeChapterHtml: 'readonly',
        save: 'readonly',
        selText: 'readonly',
        setTocTab: 'readonly',
        showLoader: 'readonly',
        snapshotPage: 'readonly',
        statsCache: 'readonly',
        syncWarm: 'readonly',
        tauriOpenPath: 'readonly',
        tocCurIdx: 'readonly',
        tocItems: 'readonly',
        toggleSheet: 'readonly',
        toggleToc: 'readonly',
        turn: 'readonly',
        turnGesture: 'readonly',
        turnQueue: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
