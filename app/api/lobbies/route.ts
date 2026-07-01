import { createLobby } from "@/lib/multiplayer";
import { jsonError, jsonOk, parseJsonBody } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await parseJsonBody(request);
    const lobby = await createLobby(body);
    return jsonOk(lobby, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
