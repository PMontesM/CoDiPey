import { describe, expect, it } from "vitest";
import {
  parseFiscalData,
  parseProductLines,
  sumItems,
  xmlEscape,
} from "../src/lib/parse";
import { ensureMenuActions } from "../src/lib/twilio";

describe("parseProductLines", () => {
  it("parses single and multi line products", () => {
    const one = parseProductLines("1 Prueba CoDi 0.01");
    expect(one.error).toBeNull();
    expect(one.items?.[0]).toMatchObject({
      cantidad: "1",
      concepto: "Prueba CoDi",
      precio_unitario: "0.01",
      subtotal: "0.01",
    });

    const multi = parseProductLines("2 Cafe 45\n1 Agua 10");
    expect(multi.error).toBeNull();
    expect(sumItems(multi.items!)).toBe("100.00");
  });

  it("rejects invalid lines and non-positive prices", () => {
    expect(parseProductLines("hola").error).toMatch(/No entendí/);
    expect(parseProductLines("1 Cafe 0").error).toMatch(/mayores a 0/);
    expect(parseProductLines("1 Cafe -5").error).toBeTruthy();
  });
});

describe("parseFiscalData", () => {
  it("accepts valid pipe-separated fiscal data", () => {
    const { data, error } = parseFiscalData(
      "XAXX010101000 | PUBLICO EN GENERAL | 06600 | 616 | G03",
    );
    expect(error).toBeNull();
    expect(data).toEqual({
      rfc: "XAXX010101000",
      razon_social: "PUBLICO EN GENERAL",
      codigo_postal: "06600",
      regimen: "616",
      uso_cfdi: "G03",
    });
  });

  it("rejects incomplete or bad CP", () => {
    expect(parseFiscalData("RFC | Nombre").error).toMatch(/incompletos/i);
    expect(
      parseFiscalData("XAXX010101000 | PUBLICO EN GENERAL | 660 | 616 | G03")
        .error,
    ).toMatch(/código postal/i);
  });
});

describe("xmlEscape", () => {
  it("escapes XML special chars for TwiML", () => {
    expect(xmlEscape(`a&b<c>"d`)).toBe("a&amp;b&lt;c&gt;&quot;d");
  });
});

describe("ensureMenuActions", () => {
  it("keeps Menú as 3rd slot by default (drops 3rd primary)", () => {
    const out = ensureMenuActions([
      { title: "Sí, esos", id: "FISCAL_KEEP" },
      { title: "Sin RFC", id: "FISCAL_DEMO" },
      { title: "Otros datos", id: "FISCAL_EDIT" },
    ]);
    expect(out.map((a) => a.id)).toEqual([
      "FISCAL_KEEP",
      "FISCAL_DEMO",
      "MENU",
    ]);
  });

  it("preserves Otros datos when stickyMenu is false", () => {
    const out = ensureMenuActions(
      [
        { title: "Sí, esos", id: "FISCAL_KEEP" },
        { title: "Otros datos", id: "FISCAL_EDIT" },
        { title: "Sin RFC", id: "FISCAL_DEMO" },
      ],
      false,
    );
    expect(out.map((a) => a.id)).toEqual([
      "FISCAL_KEEP",
      "FISCAL_EDIT",
      "FISCAL_DEMO",
    ]);
  });
});
