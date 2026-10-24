import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";

export async function pushProvider(secret: string) {
  const counts: Record<string, number> = {};
  let statuses: Record<string, number> = {};
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401).end("{}"); return;
    }
    if (request.method === "GET" && request.url === "/control") {
      response.end(JSON.stringify({ counts })); return;
    }
    if (request.method !== "POST" || !["/", "/control"].includes(request.url ?? "")) {
      response.writeHead(404).end("{}"); return;
    }
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const part = Buffer.from(chunk); size += part.length;
        if (size > 64 * 1024) throw new Error("Oversized synthetic request.");
        parts.push(part);
      }
      const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (request.url === "/control") {
        statuses = z.object({ statuses: z.record(z.number().int().min(200).max(599)) }).strict().parse(body).statuses;
        response.end(JSON.stringify({ counts })); return;
      }
      const value = z.object({
        device: z.string().startsWith("/"), payload: z.object({ title: z.string(), body: z.string(), url: z.literal("/") }).strict(),
      }).strict().parse(body);
      counts[value.device] = (counts[value.device] ?? 0) + 1;
      response.writeHead(statuses[value.device] ?? 201).end("{}");
    } catch { response.writeHead(400).end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic push fixture did not bind.");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
