# Pico CSS, vendored (ORBIT's scoped build)

The web page's component library. Why Pico, what it styles and how the page uses it are in
[docs/ui-library.md](../../../../docs/ui-library.md); this note is about the files.

| File | What it is |
|---|---|
| `pico.orbit.min.css` | The built stylesheet the page imports. Served by ORBIT at `/vendor/pico.orbit.min.css` (`src/server.ts`); never from a CDN. 40,777 bytes (about 6 KB gzipped). |
| `orbit-pico.scss` | The build's input: Pico's own Sass entry point with ORBIT's settings. |
| `build.sh` | Rebuilds `pico.orbit.min.css` from the two pinned npm packages and `orbit-pico.scss`. |
| `LICENSE.md` | Pico's MIT licence, copied from the package. |

- **Library:** [Pico CSS](https://picocss.com) 2.1.1, MIT, from the npm package `@picocss/pico@2.1.1`
  (registry integrity `sha512-kIDugA7Ps4U+2BHxiNHmvgPIQDWPDU4IeU6TNRdvXQM1uZX+FibqDQT2xUOnnO2yq/LUHcwnGlu1hvf4KfXnMg==`).
- **Compiler:** `sass@1.107.1` (Dart Sass), used only by `build.sh`. It is not a dependency of ORBIT.
- **Output:** `pico.orbit.min.css`, sha256 `eb0efc5d835b1aa55fe2f926aed07b3d8b757e8cfb52c079c29dde98469f753b`.
  `test/ui-library.test.ts` checks this hash, so an edit by hand fails the tests: change `orbit-pico.scss` and rebuild.

## Why a build and not Pico's ready-made files

Pico ships ready-made CSS, including a "conditional" file that styles only inside `.pico`. It still styles the whole page
from its document module (the root font size, which grows to 131% on wide screens and so changes every `rem`, plus the
root `overflow-wrap`, font and colours) and has page-level layout rules (`body`, `main`, `.container`, `.grid`). ORBIT's
page already has its own document, layout and button styles, so the build turns those modules off and keeps only:

- the theme variables (all named `--pico-*`, so they cannot collide with ORBIT's tokens),
- form basics, checkbox and radio (the selects, the Show archived and Needs attention checkboxes, the theme radios),
- the card, dropdown, nav and loading components, and the reduced-motion utility.

Every remaining rule is under `.pico`. The only declarations outside it are Pico's `--pico-*` variables and `color-scheme`
on the root, which ORBIT's own stylesheet sets for every theme anyway; `test/ui-library.test.ts` checks both of these and
that nothing outside a `.pico` element changes when the library loads.

## Rebuilding (a one-off vendoring step)

ORBIT has no build step; this is only for upgrading Pico or changing the module list.

```sh
src/web/vendor/pico/build.sh      # needs Node, npm and the npm registry; works in a temporary folder
```

It installs the pinned `@picocss/pico` and `sass` versions into a temporary folder (no install scripts), compiles
`orbit-pico.scss`, removes the byte-order mark Sass adds, copies the licence and prints the new sha256. Put that hash in
this README and in `test/ui-library.test.ts`, then run the tests and look at the page in Light and Dark. Running it
unchanged reproduces the committed file byte for byte.

To upgrade Pico: change `PICO_VERSION` in `build.sh` and the version checks in `test/ui-library.test.ts`, check Pico's
changelog for renamed variables (the bridge in `src/web/index.html` maps `--pico-*` onto ORBIT's tokens), rebuild, and run
the tests.
