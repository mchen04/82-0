import { jsonError, jsonOk } from "@/lib/http";
import { joinLobby } from "@/lib/multiplayer";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const body = await request.json().catch(() => ({}));
    const joined = await joinLobby(code, body);
    return jsonOk(joined, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
