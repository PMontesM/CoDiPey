import type { Env } from "../types";

/**
 * Superadmin: solo con SUPERADMIN_SECRET de Wrangler (no se puede pisar desde D1).
 * Header: Authorization Bearer … o x-superadmin-token.
 */
export function requireSuperadmin(
  request: Request,
  env: Env,
): Response | null {
  const secret = (env.SUPERADMIN_SECRET || "").trim();
  if (!secret) {
    return Response.json(
      {
        detail:
          "Superadmin desactivado: define SUPERADMIN_SECRET en Wrangler (una sola vez) y vuelve a desplegar.",
        configured: false,
      },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
  const auth = request.headers.get("authorization") || "";
  const headerToken = request.headers.get("x-superadmin-token") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (bearer === secret || headerToken === secret) {
    return null;
  }
  return Response.json(
    { detail: "No autorizado", configured: true },
    { status: 401, headers: { "cache-control": "private, no-store" } },
  );
}

export function superadminConfigured(env: Env): boolean {
  return Boolean((env.SUPERADMIN_SECRET || "").trim());
}
