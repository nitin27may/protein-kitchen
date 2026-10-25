import { timingSafeEqual } from "node:crypto";

export function authorizeScheduler(request: Request, secret: string | undefined, preview: boolean): "authorized" | "disabled" | "unauthorized" {
  if (preview || !secret || !/^[a-zA-Z0-9_-]{32,128}$/.test(secret)) return "disabled";
  const received = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (!received || Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return "unauthorized";
  return "authorized";
}

export async function hasSchedulerPayload(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Scheduler request body timed out.")), 2_000);
  });
  try {
    for (let i = 0; i < 8; i++) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) return false;
      if (chunk.value.byteLength) return true;
    }
    return true;
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
}
