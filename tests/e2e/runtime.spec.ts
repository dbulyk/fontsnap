import { expect, openResultPage, test } from './fixtures';

// onnxruntime-web fetches its .wasm with the global `fetch`. In this page that function can be replaced by any code
// that runs in it (review of PR #6), so the runtime is started in a worker of its own (env.wasm.proxy): the .wasm is
// fetched and compiled there, in a global scope the page cannot reach. This is the browser proof that it is so.
test('the runtime loads its WebAssembly in its own worker, not through the fetch of the page', async ({
  context,
  extensionId,
}) => {
  await context.addInitScript(() => {
    const seen: string[] = [];
    const real = window.fetch.bind(window);
    Object.defineProperty(window, '__pageFetches', { value: seen });
    window.fetch = (input, init) => {
      seen.push(input instanceof Request ? input.url : input.toString());
      return real(input, init);
    };
  });
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  const fetched = await page.evaluate(
    () => (window as unknown as { __pageFetches: string[] }).__pageFetches,
  );
  const base = `chrome-extension://${extensionId}/`;
  expect(fetched).toEqual([`${base}model/meta.json`, `${base}model/model_fp16.onnx`]);
  expect(page.workers().map((worker) => worker.url())).toContain(`${base}ort/ort.wasm.min.mjs`);
});
