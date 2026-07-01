import { jsonOk } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  return jsonOk({ ok: true });
}
