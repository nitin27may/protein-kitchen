import { AuthConfigurationError } from "@/lib/auth/config";
import { getAuth } from "@/lib/auth/server";

export const runtime = "nodejs";

async function handler(request: Request) {
  try {
    const auth = await getAuth();
    const response = await auth.handler(request);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Authentication is not configured.", { message: error.message });
    return Response.json({ message: "Authentication is not configured on this instance." }, {
      status: 503, headers: { "Cache-Control": "private, no-store" },
    });
  }
}

export { handler as GET, handler as POST };
