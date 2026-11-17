import type { Env, Item, Orden } from "../types";
import { getBlob } from "./blobs";
import { runAllConnectionTests } from "./connection-tests";
import { simularCobroDemo, simularPagoDemo } from "./demo";
import { ensureSettingsTable } from "./settings";
import { renderTicketHtmlPage } from "./ticket";

export type E2eStep = {
  id: string;
  label: string;
  ok: boolean;
  message: string;
  ms: number;
};

export type E2eReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  orden_id?: number;
  steps: E2eStep[];
};

const LAST_KEY = "_E2E_LAST";

async function step(
  id: string,
  label: string,
  fn: () => Promise<string>,
): Promise<E2eStep> {
  const t0 = Date.now();
  try {
    const message = await fn();
    return { id, label, ok: true, message, ms: Date.now() - t0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { id, label, ok: false, message, ms: Date.now() - t0 };
  }
}

export async function saveE2eReport(env: Env, report: E2eReport): Promise<void> {
  try {
    await ensureSettingsTable(env);
    const ts = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(LAST_KEY, JSON.stringify(report), ts)
      .run();
  } catch (err) {
    console.log(`[e2e] save last run failed: ${String(err)}`);
  }
}

export async function loadE2eReport(env: Env): Promise<E2eReport | null> {
  try {
    await ensureSettingsTable(env);
    const row = await env.DB.prepare(
      "SELECT value FROM settings WHERE key = ?",
    )
      .bind(LAST_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    return JSON.parse(row.value) as E2eReport;
  } catch {
    return null;
  }
}

/**
 * Prueba E2E operativa: config → D1 → APIs → cobro demo → pago → ticket.
 * Crea una orden real de demo ($25) en D1 (como Simular Cobro del panel).
 */
export async function runE2eHealth(
  env: Env,
  publicUrl: string,
): Promise<E2eReport> {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const steps: E2eStep[] = [];
  let ordenId: number | undefined;

  steps.push(
    await step("config.public_url", "PUBLIC_URL HTTPS", async () => {
      const u = (publicUrl || "").replace(/\/$/, "");
      if (!/^https:\/\//i.test(u)) {
        throw new Error(`PUBLIC_URL no es HTTPS: ${u || "(vacío)"}`);
      }
      return u;
    }),
  );

  steps.push(
    await step("config.pey_webhook", "PEY_WEBHOOK_SECRET", async () => {
      if (!(env.PEY_WEBHOOK_SECRET || "").trim()) {
        throw new Error(
          "Falta PEY_WEBHOOK_SECRET — sin esto pey no puede liquidar pagos reales",
        );
      }
      return "Configurado";
    }),
  );

  steps.push(
    await step("d1", "Base D1", async () => {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ordenes").first<{
        n: number;
      }>();
      return `${Number(row?.n || 0)} órdenes en D1`;
    }),
  );

  const connections = await runAllConnectionTests(env);
  for (const c of connections) {
    steps.push({
      id: `api.${c.id}`,
      label: `API ${c.id}`,
      ok: c.ok,
      message: c.message,
      ms: 0,
    });
  }

  const apisOk = connections.every((c) => c.ok);
  if (apisOk) {
    const cobro = await step("flow.cobro", "Cobro demo + QR pey", async () => {
      const result = await simularCobroDemo(env, publicUrl);
      ordenId = result.orden.id;
      if (!result.orden.pey_qr_id) {
        throw new Error(`Orden #${ordenId} sin pey_qr_id`);
      }
      return `Orden #${ordenId} · QR ${result.orden.pey_qr_id}`;
    });
    steps.push(cobro);

    if (cobro.ok && ordenId) {
      const id = ordenId;
      steps.push(
        await step("flow.pago", "Liquidar + timbrar CFDI", async () => {
          const result = await simularPagoDemo(env, publicUrl, id);
          if (result.orden.pago_estado !== "PAGADO") {
            throw new Error(`pago_estado=${result.orden.pago_estado}`);
          }
          const cfdi = result.orden.facturapi_id
            ? `CFDI ${result.orden.facturapi_id}`
            : "sin CFDI";
          return `Orden #${id} PAGADO · ${cfdi}`;
        }),
      );

      // No hacemos fetch al propio Worker (en CF suele 404 por loopback).
      // Validamos el mismo camino que usan las rutas /ticket y /files.
      steps.push(
        await step("flow.ticket", "Ticket HTML (render interno)", async () => {
          const orden = await env.DB.prepare(
            "SELECT * FROM ordenes WHERE id = ?",
          )
            .bind(id)
            .first<Orden>();
          if (!orden) throw new Error("Orden no encontrada en D1");
          let items: Item[] = [];
          try {
            const raw = JSON.parse(orden.conceptos) as Item[];
            if (Array.isArray(raw)) items = raw;
          } catch {
            items = [];
          }
          const base = publicUrl.replace(/\/$/, "");
          const html = renderTicketHtmlPage({
            meta: {
              ordenId: orden.id,
              monto: String(orden.monto),
              items,
              concepto: orden.concepto_pey || undefined,
              peyQrId: orden.pey_qr_id,
              vigenciaMin: 10,
              businessName:
                (env.BUSINESS_NAME || "Mostrito").trim() || "Mostrito",
            },
            qrImageUrl: `${base}/files/qr_code_${orden.id}.png`,
            estado: orden.pago_estado === "PAGADO" ? "PAGADO" : "PENDIENTE",
            paymentUrl: orden.pey_payment_url ?? null,
          });
          if (!/ticket|total/i.test(html) || !html.includes(`#${orden.id}`)) {
            throw new Error("HTML de ticket inesperado");
          }
          return `${base}/ticket/${id} · ${html.length} chars`;
        }),
      );

      steps.push(
        await step("flow.qr_file", "Archivo QR PNG (D1 blobs)", async () => {
          const keys = [`qr_${id}.png`, `qr_code_${id}.png`];
          const found: string[] = [];
          for (const key of keys) {
            const blob = await getBlob(env, key);
            if (blob && blob.data.byteLength >= 32) {
              found.push(`${key} (${blob.data.byteLength} B)`);
            }
          }
          if (!found.length) {
            throw new Error(`Sin blobs ${keys.join(" / ")}`);
          }
          return found.join(" · ");
        }),
      );
    }
  } else {
    steps.push({
      id: "flow.skipped",
      label: "Flujo cobro/pago",
      ok: false,
      message: "Omitido: falla alguna API (pey / Facturapi / Twilio)",
      ms: 0,
    });
  }

  const finished = new Date().toISOString();
  const report: E2eReport = {
    ok: steps.every((s) => s.ok),
    started_at: started,
    finished_at: finished,
    duration_ms: Date.now() - t0,
    orden_id: ordenId,
    steps,
  };
  await saveE2eReport(env, report);
  return report;
}
