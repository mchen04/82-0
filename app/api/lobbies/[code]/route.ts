import { AppError } from "@/lib/errors";
import { jsonError, jsonOk } from "@/lib/http";
import { getLobbyStateIfChanged } from "@/lib/multiplayer";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const since = parseSince(url.searchParams.get("since"));
    const result = await getLobbyStateIfChanged(code, token, since);
    if (!result.changed) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    return jsonOk(result.state, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

function parseSince(value: string | null) {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(400, "bad_since", "Invalid state version.");
  }
  return parsed;
}
