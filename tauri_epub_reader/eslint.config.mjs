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
    'no-redeclare': 'error',

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
  { ignores: ['node_modules/**', 'src-tauri/target/**', 'tests/e2e/artifacts/**'] },

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
];
