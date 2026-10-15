# FontSnap — Privacy Policy

_Last updated: 14 October 2026_

FontSnap ("the extension") is a Chrome extension that identifies the font in a selected area of a web page or in an image you provide. This policy explains what the extension does with data. Short version: **your images are processed on your device and are never sent to us or to anyone else.**

## What the extension processes

- **Screenshots and images you choose.** When you select an area, right-click an image or paste/drop/upload a picture, the extension creates an image of that area or reads the picture. The image is analysed by an AI model that is bundled with the extension and runs locally in your browser (WebAssembly). The image is not uploaded anywhere.
- **Text under your selection.** To show previews with your own words, the extension may read up to 80 characters of visible text inside the area you selected. This text stays in your browser.
- **Temporary storage.** To pass a capture from the page to the results tab, the extension keeps it in `chrome.storage.session` (in-memory, cleared when the browser closes) and deletes it as soon as the results tab has read it. The extension does not keep a history of your images or results.

## Network requests

The extension contains no analytics, ads or tracking code and has no server of its own. The only network requests it makes are:

- **Google Fonts previews.** To draw the suggested fonts, the results page loads font files from `fonts.googleapis.com` / `fonts.gstatic.com`. These requests contain only the **font family names** being previewed. Like any web request, they are received by Google together with your IP address and browser information and are subject to the [Google Privacy Policy](https://policies.google.com/privacy). No images or page text are included.
- **Right-click on an image.** To analyse an image you right-clicked, the extension may download that image from the address where the web page already loads it from (the same request your browser makes to show the page). If that is not possible, it takes a screenshot of the visible tab instead.

## What we do not do

- We do not collect, store, sell or share personal data or browsing history.
- We do not use data for advertising, credit-worthiness or any purpose unrelated to identifying fonts.
- We do not use remote code: all code and the AI model are shipped inside the extension package.

## Permissions

- `activeTab` and `scripting` — to show the selection overlay and capture the visible area of the current tab only after you click the extension, use its shortcut or its context menu.
- `contextMenus` — to add "Identify font in this image" and "Select an area to identify font" to the right-click menu.
- `storage` — to hand a capture over to the results tab (session storage, see above).

## Children

The extension is not directed at children and does not knowingly collect any information from anyone.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Questions: dmbulyk+fontsnap.support@gmail.com
