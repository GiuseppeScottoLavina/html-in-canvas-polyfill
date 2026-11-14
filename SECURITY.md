# Security policy

## Supported versions

The policy of `docs/STABILITY.md` (section 2, "Older lines") applies: within a major line, a fix, security fixes included, ships in a release of its newest minor, published under the npm dist-tag `next` and moved to `latest` once checked; when a new major is released, the previous line gets security fixes for six months. The release candidates and previews before `1.0.0` get no fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's "Report a vulnerability" button on the Security tab (https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/security/advisories/new), or by email to giuseppe.sc8.lavina@gmail.com.

Include the affected version, the browser and version, a minimal page that shows the problem, and what an attacker gains. You should get a first answer within 7 days. This is a volunteer project: there is no bounty.

## Scope

The polyfill runs inside the page that loads it, with that page's privileges. Relevant reports include, for example: a drawn snapshot that exposes pixels the HTML-in-Canvas privacy rules exclude (cross-origin content, `:visited` styles, content outside the drawable subtree), script execution caused by the polyfill's own serialisation of page content, or a network request the polyfill makes on its own. The bundles make no network request when they load (the optional loader downloads nothing over a complete native implementation, the native bridge and the core over an earlier native build that the bridge completes, and the core, with the engines bundle on Firefox and Safari, where the polyfill runs). To draw a snapshot, the polyfill fetches the same-origin and CORS-enabled resources the drawn HTML references and inlines them as `data:` URLs (README, "Known limitations").

Out of scope: problems that need the page author to load untrusted script, and limits that are already documented in `docs/SUPPORT-MATRIX.md` and `docs/CONFORMANCE.md`.
