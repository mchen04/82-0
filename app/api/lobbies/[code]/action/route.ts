import { jsonError, jsonOk, parseJsonBody } from "@/lib/http";
import { applyLobbyAction } from "@/lib/multiplayer";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const body = await parseJsonBody(request);
    const state = await applyLobbyAction(code, body);
    return jsonOk(state);
  } catch (error) {
    return jsonError(error);
  }
}
