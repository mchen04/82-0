import { jsonError, jsonOk } from "@/lib/http";
import { cleanupExpiredLobbies } from "@/lib/multiplayer";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret && process.env.NODE_ENV === "production") {
      throw new AppError(503, "cron_unconfigured", "Cleanup cron is not configured.");
    }
    if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
      throw new AppError(401, "unauthorized", "Unauthorized.");
    }
    return jsonOk(await cleanupExpiredLobbies());
  } catch (error) {
    return jsonError(error);
  }
}
