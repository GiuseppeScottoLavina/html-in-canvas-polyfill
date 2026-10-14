# Security policy

## Supported versions

Only the newest preview published under the npm dist-tag `next` receives fixes. There is no stable release yet.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's "Report a vulnerability" button on the Security tab (https://github.com/GiuseppeScottoLavina/html-in-canvas-polyfill/security/advisories/new), or by email to giuseppe.sc8.lavina@gmail.com.

Include the affected version, the browser and version, a minimal page that shows the problem, and what an attacker gains. You should get a first answer within 7 days. This is a volunteer project: there is no bounty.

## Scope

The polyfill runs inside the page that loads it, with that page's privileges. Relevant reports include, for example: a drawn snapshot that exposes pixels the HTML-in-Canvas privacy rules exclude (cross-origin content, `:visited` styles, content outside the drawable subtree), script execution caused by the polyfill's own serialisation of page content, or a network request the polyfill makes on its own. The polyfill makes no network request when it loads; snapshots inline same-origin and CORS-enabled resources as `data:` URLs (README, "Known limitations").

Out of scope: problems that need the page author to load untrusted script, and limits that are already documented in `docs/SUPPORT-MATRIX.md` and `docs/CONFORMANCE.md`.
