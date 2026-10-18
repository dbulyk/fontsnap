// The test page is generated from these constants so specs assert against the same values.
export const SAMPLE_TEXT = 'Hamburgefonstiv';

export function renderSitePage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>FontSnap test page</title></head>
  <body style="margin:0;background:#fff">
    <p id="sample" style="margin:60px 40px;font:700 56px/1.3 Georgia,serif;color:#111">${SAMPLE_TEXT}</p>
  </body>
</html>
`;
}
