/* ESLint pro frontend a testy – hlídá skutečné chyby (nedefinované proměnné,
   nepoužité symboly, == vs ===), ne styl. Vendor knihovny se nekontrolují. */
import globals from "globals";

const rules = {
  "no-undef": "error",
  "no-unused-vars": ["error", {
    args: "none",                 // nepoužité parametry callbacků jsou běžné
    caughtErrors: "none",         // catch (e) bez použití je v pořádku
    varsIgnorePattern: "^_",
  }],
  eqeqeq: ["error", "smart"],     // == jen proti null
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  "no-shadow": "warn",
  "no-implicit-globals": "error",
};

export default [
  {
    ignores: ["app/static/vendor/**", "node_modules/**", "playwright-report/**"],
  },
  {
    // aplikační ES moduly v prohlížeči (Leaflet je globální L)
    files: ["app/static/**/*.js"],
    ignores: ["app/static/sw.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, L: "readonly", protomapsL: "readonly" },
    },
    rules,
  },
  {
    // service worker běží mimo DOM
    files: ["app/static/sw.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: globals.serviceworker,
    },
    rules,
  },
  {
    // e2e testy a skripty běží v Node; kód v page.evaluate() ale v prohlížeči
    files: ["tests/e2e/**/*.mjs", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules,
  },
];
