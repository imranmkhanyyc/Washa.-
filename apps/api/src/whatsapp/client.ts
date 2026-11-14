import { validateOut, type OutMessage, type WhatsAppClient } from "./types";

/** Maps our OutMessage to a Cloud API /messages payload. */
export function toGraphPayload(to: string, msg: OutMessage): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };
  switch (msg.kind) {
    case "text":
      return { ...base, type: "text", text: { body: msg.body, preview_url: false } };
    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: msg.body },
          action: { buttons: msg.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      };
    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: msg.body },
          action: { button: msg.button, sections: [{ title: "Options", rows: msg.rows }] },
        },
      };
    case "location_request":
      return {
        ...base,
        type: "interactive",
        interactive: { type: "location_request_message", body: { text: msg.body }, action: { name: "send_location" } },
      };
    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: msg.name,
          language: { code: msg.lang ?? "en" },
          components: msg.params.length
            ? [{ type: "body", parameters: msg.params.map((p) => ({ type: "text", text: p })) }]
            : [],
        },
      };
  }
}

export class GraphWhatsAppClient implements WhatsAppClient {
  constructor(private opts: { graphVersion: string; phoneNumberId: string; accessToken: string }) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.opts.graphVersion}/${path}`;
  }

  async send(to: string, msg: OutMessage) {
    validateOut(msg);
    const res = await fetch(this.url(`${this.opts.phoneNumberId}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(toGraphPayload(to, msg)),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp send failed: ${res.status} ${json?.error?.message ?? ""}`);
    return { waMessageId: String(json?.messages?.[0]?.id ?? "") };
  }

  async getMedia(mediaId: string) {
    const auth = { Authorization: `Bearer ${this.opts.accessToken}` };
    const meta: any = await (await fetch(this.url(mediaId), { headers: auth })).json();
    if (!meta?.url) throw new Error("WhatsApp media lookup failed");
    const res = await fetch(meta.url, { headers: auth });
    if (!res.ok) throw new Error(`WhatsApp media download failed: ${res.status}`);
    return { data: Buffer.from(await res.arrayBuffer()), mimeType: String(meta.mime_type ?? "image/jpeg") };
  }
}

/** Records outbound messages instead of calling Meta. Used by tests and simulate-order. */
export class FakeWhatsAppClient implements WhatsAppClient {
  outbox: { to: string; msg: OutMessage; waMessageId: string }[] = [];
  media = new Map<string, { data: Buffer; mimeType: string }>();
  private n = 0;
  async send(to: string, msg: OutMessage) {
    validateOut(msg);
    const waMessageId = `wamid.out.${++this.n}`;
    this.outbox.push({ to, msg, waMessageId });
    return { waMessageId };
  }
  async getMedia(mediaId: string) {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`no fake media ${mediaId}`);
    return m;
  }
  to(waId: string) {
    return this.outbox.filter((o) => o.to === waId).map((o) => o.msg);
  }
  last(waId: string) {
    return this.to(waId).at(-1);
  }
}
