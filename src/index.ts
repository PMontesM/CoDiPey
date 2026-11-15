import { Container, getContainer } from "@cloudflare/containers";

/**
 * Un solo contenedor singleton: SQLite + archivos QR/PDF viven en la misma
 * instancia mientras no duerma. enableInternet=true para pey/Facturapi/Twilio.
 */
export class CobroBackend extends Container {
  defaultPort = 8080;
  sleepAfter = "24h";
  enableInternet = true;
}

export default {
  async fetch(
    request: Request,
    env: { COBRO_BACKEND: DurableObjectNamespace },
  ): Promise<Response> {
    // Siempre la misma instancia → mismo disco / misma DB
    const container = getContainer(env.COBRO_BACKEND, "singleton");
    return container.fetch(request);
  },
};
