import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError } from "./errors";
import { isAppError } from "./errors";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function parseJsonBody(request: Request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "bad_json", "Malformed JSON request body.");
  }
}

export function jsonError(error: unknown) {
  if (isAppError(error)) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "bad_request", message: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  console.error(error);
  return NextResponse.json({ error: "server_error", message }, { status: 500 });
}
