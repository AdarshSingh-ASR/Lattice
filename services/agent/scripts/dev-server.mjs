import http from "node:http";
import { handler } from "../src/index.mjs";

const port = Number(process.env.PORT || 8787);

const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");

  const url = new URL(request.url, `http://${request.headers.host}`);
  const result = await handler({
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: {
      http: { method: request.method },
      requestId: request.headers["x-request-id"] || crypto.randomUUID(),
    },
    headers: request.headers,
    body: body || undefined,
  });

  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Lattice agent listening on http://127.0.0.1:${port}`);
});
