# Changelog

## v1.5.0 (2025-09-20)

### Reasoning for Architectural Refactor

Upon analyzing the `fancytracker` extension, a more modern and efficient architecture for executing code in the context of a web page was identified. Our previous method involved using a content script (`infiltrator.js`) to inject a `<script>` tag into the page's DOM. While effective, this approach has minor drawbacks in terms of performance and code complexity, as it requires DOM manipulation and stringifying the code to be injected.

The `fancytracker` extension utilizes the `"world": "MAIN"` property in its manifest's `content_scripts` definition. This is the current best practice recommended by the Chrome extension platform. It allows a content script to run directly in the page's main JavaScript world, giving it immediate access to `window` and other page-level APIs without any DOM manipulation hacks. Adopting this architecture makes our code cleaner, more performant, and better aligned with modern extension development standards.

### Detailed Changes

*   **Modernized Injection:** Replaced the DOM-based script injection with the `"world": "MAIN"` content script architecture.
*   **New Pacifier Script:** Created a new, simpler `pacifier.js` script that runs in the MAIN world and directly overrides service worker methods.
*   **Manifest Update:** Updated `manifest.json` to remove the old script and register `pacifier.js`.
*   **Removed Obsolete Code:** Deleted the now-redundant `infiltrator.js` file.

## v1.4.0 (2025-09-20)

*   **Enhanced Pacification:** Upgraded the service worker nullification logic to be significantly stealthier. The `navigator.serviceWorker.register` method now returns a resolved `Promise` with a fake registration object instead of a rejected `Promise`. This prevents easy detection by web applications. The technique was adapted from analysis of the `4ndr0infiltrator` project.

## v1.3.0

*   **Architectural Refactor:** Overhauled the core logic to eliminate a critical race condition. The extension now injects a script synchronously at `document_start` to disable service workers immediately on all pages.
*   **New Content Script:** Added `infiltrator.js` to handle the synchronous injection.
*   **Inverted Background Logic:** Modified `background.js` to be responsible for *restoring* service worker functionality on whitelisted domains, rather than disabling it on non-whitelisted ones.
