import { routeAccess } from "@/lib/auth/access";
import { privateJson } from "@/lib/auth/response";
import { readAccountExport } from "@/lib/server/account-export";
import { getDb } from "@/lib/server/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const access = await routeAccess(request);
  if (access.response) return access.response;
  if (new URL(request.url).search) return privateJson({ ok: false, error: "Account downloads do not accept query parameters." }, 400);
  const data = await readAccountExport(await getDb(), access.member);
  if (!data) return privateJson({ ok: false, error: "Your household membership or profile is no longer available." }, 403);
  const response = privateJson(data);
  response.headers.set("Content-Disposition", 'attachment; filename="protein-kitchen-account.json"');
  return response;
}
