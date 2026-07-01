import { getLobbyState } from "@/lib/multiplayer";
import { jsonError, jsonOk } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const state = await getLobbyState(code, token);
    return jsonOk(state);
  } catch (error) {
    return jsonError(error);
  }
}
