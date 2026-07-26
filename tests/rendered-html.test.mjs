import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://lattice.example/", {
      headers: {
        accept: "text/html",
        host: "lattice.example",
        "x-forwarded-host": "lattice.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Lattice control room", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Lattice — Incident memory control plane<\/title>/i);
  assert.match(html, /Checkout degradation/);
  assert.match(html, /Run memory trace/);
  assert.match(html, /Unsigned workaround/);
  assert.match(html, /SERIALIZABLE/);
  assert.match(html, /AS OF SYSTEM TIME/);
  assert.match(html, /human gate/i);
  assert.match(html, /aria-controls="operator-menu"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("publishes an absolute product social card", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(
    html,
    /<meta(?=[^>]*property="og:image")(?=[^>]*content="https:\/\/lattice\.example\/og\.png")[^>]*>/i,
  );
  assert.match(
    html,
    /<meta(?=[^>]*name="twitter:card")(?=[^>]*content="summary_large_image")[^>]*>/i,
  );
  await access(new URL("../public/og.png", import.meta.url));
});

test("removes the disposable starter surface", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview/", import.meta.url)));
});
