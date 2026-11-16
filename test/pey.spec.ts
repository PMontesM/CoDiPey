import { describe, expect, it } from "vitest";
import { extractPaymentLink } from "../src/lib/pey";
import { formatTicketCaption } from "../src/lib/ticket";

describe("extractPaymentLink", () => {
  it("toma url de /payment-link/create", () => {
    expect(
      extractPaymentLink({ id: "01ABC", url: "https://pay.pey.mx/abc" }),
    ).toBe("https://pay.pey.mx/abc");
  });

  it("toma el campo explícito de pago", () => {
    expect(
      extractPaymentLink({ qr: "000201...", paymentUrl: "https://pay.pey.mx/abc" }),
    ).toBe("https://pay.pey.mx/abc");
  });

  it("busca también dentro de data", () => {
    expect(
      extractPaymentLink({ data: { paymentLink: "https://pay.pey.mx/xyz" } }),
    ).toBe("https://pay.pey.mx/xyz");
  });

  it("regresa null si no hay link (respuesta típica de /codi/qr)", () => {
    expect(
      extractPaymentLink({ id: "abc", qrString: "000201..." }),
    ).toBeNull();
  });

  it("rechaza valores que no son URL", () => {
    expect(extractPaymentLink({ url: "0002016304..." })).toBeNull();
  });
});

describe("formatTicketCaption con link de pago", () => {
  const meta = {
    ordenId: 42,
    monto: "150.00",
    items: [
      {
        cantidad: "1",
        concepto: "Café",
        precio_unitario: "150.00",
        subtotal: "150.00",
      },
    ],
    concepto: "Pedido",
    vigenciaMin: 10,
    peyQrId: "qr_1",
  };
  const opts = {
    mediaUrl: "https://x/files/qr_42.png",
    ticketUrl: "https://x/ticket/42",
  };

  it("incluye el link de pago cuando existe", () => {
    const caption = formatTicketCaption(meta, {
      ...opts,
      paymentUrl: "https://pay.pey.mx/abc",
    });
    expect(caption).toContain("https://pay.pey.mx/abc");
    expect(caption).toContain("sin escanear");
    expect(caption).toContain("https://x/ticket/42");
  });

  it("no cambia el mensaje cuando no hay link", () => {
    const caption = formatTicketCaption(meta, opts);
    expect(caption).not.toContain("sin escanear");
    expect(caption).toContain("https://x/ticket/42");
  });
});
