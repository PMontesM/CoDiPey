/**
 * Headed Playwright walkthrough for hackathon demo video.
 * Captured via RecordScreen on DISPLAY=:1.
 *
 * Usage: npm i -D playwright && DISPLAY=:1 node scripts/demo-video.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.DEMO_BASE || "https://cobro-codi.inomali.workers.dev";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--start-maximized", "--disable-infobars"],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();

  console.log("1) open admin");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await sleep(3000);

  console.log("2) click + Simular Cobro WhatsApp");
  const beforeIds = await page.evaluate(() => state.orders.map((o) => o.id));
  await page.click("#btnSimularCobro");
  const createdId = await page.waitForFunction(
    (prev) => {
      const newest = state.orders.find(
        (o) =>
          o.pago_estado === "PENDIENTE" &&
          String(o.telefono).endsWith("000099") &&
          !prev.includes(o.id),
      );
      return newest ? newest.id : null;
    },
    beforeIds,
    { timeout: 25000 },
  ).then((h) => h.jsonValue());
  console.log("created", createdId);
  await sleep(2000);
  await page.evaluate((id) => selectOrder(String(id)), createdId);
  await sleep(3000);

  // Ensure pay button visible
  await page.locator("button", { hasText: "Simular Webhook Pago pey" }).first().waitFor({
    state: "visible",
    timeout: 10000,
  });
  await sleep(1500);

  console.log("3) click Simular Webhook Pago pey");
  await page.locator("button", { hasText: "Simular Webhook Pago pey" }).first().click();

  await page.waitForFunction(
    (id) => {
      const order = state.orders.find((o) => o.id === String(id));
      return order && order.pago_estado === "PAGADO";
    },
    createdId,
    { timeout: 30000 },
  );
  await sleep(1500);
  // Re-open to show stamped CFDI sheet
  await page.evaluate((id) => selectOrder(String(id)), createdId);
  await sleep(5000);
  console.log("4) success — order", createdId, "PAGADO");

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
