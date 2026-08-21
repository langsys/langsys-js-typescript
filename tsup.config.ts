import { defineConfig } from 'tsup';

export default defineConfig([
    // Package build — for bundlers and Node. Dependencies stay external so a
    // consumer's bundler dedupes `intl-messageformat` with its own copy.
    {
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
        target: 'es2021',
        treeshake: true,
        splitting: false,
        minify: false,
    },

    // Browser build — for a plain `<script>` page with no build step.
    //
    // The package build cannot be loaded directly by a browser: it carries
    // `import { IntlMessageFormat } from 'intl-messageformat'`, a bare
    // specifier a browser has no way to resolve without an import map. The
    // failure is the bad kind — the file fetches 200, then the module body
    // silently never executes, so both the network panel and the page report
    // success while nothing works. This build inlines every dependency so
    // there is nothing left to resolve.
    //
    // Deliberately NOT exposed via the top-level `browser` field: that would
    // make bundlers prefer it and ship a second copy of `intl-messageformat`
    // alongside their own. It is an explicit `./browser` subpath instead.
    //
    //   <script type="module">
    //     import { LangsysApp } from '.../dist/langsys.browser.mjs';
    //
    //   <script src=".../dist/langsys.browser.global.js"></script>
    //   <script>Langsys.LangsysApp.init({ ... })</script>
    {
        entry: { 'langsys.browser': 'src/index.ts' },
        format: ['esm', 'iife'],
        globalName: 'Langsys',
        platform: 'browser',
        noExternal: [/.*/],
        dts: false,
        // Off deliberately: several inlined `@formatjs` packages ship sourcemaps
        // whose sources collide on the same path, which fails the IIFE build
        // outright. A minified vendor bundle's map has little value anyway —
        // debug against the package build, which keeps full maps.
        sourcemap: false,
        clean: false,
        target: 'es2021',
        treeshake: true,
        splitting: false,
        minify: true,
    },
]);
