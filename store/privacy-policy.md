# FontSnap — Privacy Policy

_Last updated: 21 October 2026_

This Privacy Policy explains how the Chrome extension FontSnap: AI Font Identifier from Image ("FontSnap", "the extension", "we", "us") handles data. FontSnap identifies the font in an area of a web page, in an image on a web page or in a picture you provide, and shows the closest Google Fonts families.

**Short version: FontSnap does not collect, store or share your personal data. Your images are analysed on your device and are never sent to us or to anyone else. We have no server and no user accounts.**

## Our principles

- This policy should be short, readable and easy to find.
- The extension processes as little data as possible, only on your device and only after you ask it to.
- What the extension does should match what you expect from a font identifier.

## What the extension processes on your device

FontSnap does nothing on a web page until you start it yourself: by clicking its toolbar icon, pressing its keyboard shortcut (Alt+Shift+F) or choosing one of its items in the right-click menu.

- **The area you select.** When you drag over a part of the page, the extension takes a screenshot of the visible part of the current tab and crops it to your selection. The crop is analysed by an AI model that is bundled with the extension and runs locally in your browser (WebAssembly).
- **The image you right-click.** When you choose "Identify font in this image", the extension tries, in this order:
  1. to read the pixels of that image inside the frame of the page where you clicked. Usually the image the page already shows is used; if the browser has to load it again, it is requested from the same address the page already uses, as an anonymous (CORS) request;
  2. if that is not allowed, to scroll the image briefly into view, take a screenshot of the visible tab, crop it to the image and put the scroll position of the page back;
  3. as a last resort, to analyse the whole visible area and tell you so.
  The pixels are passed only to the extension itself and are analysed on your device.
- **Pictures you paste, drop or upload** on the FontSnap results page are read and analysed in the same way, locally.
- **Text under your selection.** To show font previews with your own words, the extension may read up to 80 characters of visible text inside the area you selected and put them into the preview field. This text stays in your browser and is not saved.
- **Temporary hand-over.** To pass a capture from the page to the results tab, the extension keeps it in `chrome.storage.session` (in memory, cleared when the browser closes) and deletes it as soon as the results tab has read it.

FontSnap does not keep a history of your images, selections, pages or results, and it does not store settings or identifiers.

## Network requests

The extension contains no analytics, advertising or tracking code, and it does not send data to any server of ours. All code and the AI model are shipped inside the extension package; no code is downloaded or run from elsewhere. The only network activity is:

- **Google Fonts previews.** To draw the suggested fonts, the results page loads style sheets and font files from `fonts.googleapis.com` and `fonts.gstatic.com`. These requests contain only the font family names being previewed, not your images or page text. Like any web request, they reach Google together with your IP address and browser information and are subject to the [Google Privacy Policy](https://policies.google.com/privacy).
- **The image you right-clicked**, if it has to be loaded again (see above). This request goes to the website that already serves the image to the page.
- **Links you click.** The "Google Fonts" link next to each result opens the font's page on fonts.google.com in your browser. That website has its own privacy policy.

## What we do not do

- We do not collect, store, sell, rent or share personal data, browsing history, page content or images.
- We do not transfer data to third parties, except the Google Fonts requests described above, which contain no personal content.
- We do not use or transfer data for advertising, for determining creditworthiness or lending, or for any purpose unrelated to identifying fonts.
- We do not use remote code.

FontSnap's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Permissions

- `activeTab` — to work on the current tab only after you start FontSnap there (toolbar icon, shortcut or right-click menu), and to take a screenshot of its visible area.
- `scripting` — to show the selection frame on that tab and, for a right-clicked image, to measure the image and read its pixels in the frame where you clicked.
- `contextMenus` — to add "Identify font in this image" and "Select an area to identify font" to the right-click menu.
- `storage` — to hand a capture over to the results tab in session storage (see above).

FontSnap requests no host permissions and cannot read websites on its own.

## Data retention and security

Because FontSnap does not collect personal data, there is nothing for us to retain, disclose or delete. Captures exist only in your browser's memory for as long as it takes to show the result. Uninstalling the extension removes it completely.

## Your rights

Laws such as the GDPR give you rights to access, correct or delete your personal data and to object to its processing. FontSnap holds no personal data about you, but you can contact us with any privacy question or request at the address below.

## Children

The extension is not directed at children under 13 and does not knowingly collect any information from anyone.

## Changes to this policy

If this policy changes, the new version will be published at this address with a new date at the top.

## Contact

Questions about this policy: dmbulyk+fontsnap@gmail.com
