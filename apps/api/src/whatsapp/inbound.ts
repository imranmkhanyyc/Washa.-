import type { InMessage } from "./types";

/** Statuses (sent/delivered/read/failed) for our outbound messages. */
export interface WaStatus {
  waMessageId: string;
  status: string;
  recipientWaId: string;
}

/** Parses a Cloud API webhook body into normalised messages and statuses. */
export function parseWebhook(body: any): { messages: InMessage[]; statuses: WaStatus[] } {
  const messages: InMessage[] = [];
  const statuses: WaStatus[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      if (!v) continue;
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c?.wa_id) names.set(c.wa_id, c?.profile?.name);
      for (const m of v.messages ?? []) {
        const base = {
          waMessageId: String(m.id),
          waId: String(m.from),
          profileName: names.get(m.from),
          timestamp: new Date(Number(m.timestamp ?? 0) * 1000),
        };
        switch (m.type) {
          case "text":
            messages.push({ ...base, kind: "text", text: String(m.text?.body ?? "") });
            break;
          case "interactive": {
            const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
            if (r) messages.push({ ...base, kind: "button", id: String(r.id), title: String(r.title ?? "") });
            else messages.push({ ...base, kind: "unsupported", type: "interactive" });
            break;
          }
          case "button": // template quick-reply
            messages.push({ ...base, kind: "button", id: String(m.button?.payload ?? m.button?.text), title: String(m.button?.text ?? "") });
            break;
          case "location":
            messages.push({ ...base, kind: "location", lat: Number(m.location.latitude), lng: Number(m.location.longitude), name: m.location.name, address: m.location.address });
            break;
          case "image":
            messages.push({ ...base, kind: "image", mediaId: String(m.image.id), mimeType: m.image.mime_type, caption: m.image.caption });
            break;
          default:
            messages.push({ ...base, kind: "unsupported", type: String(m.type) });
        }
      }
      for (const s of v.statuses ?? []) {
        statuses.push({ waMessageId: String(s.id), status: String(s.status), recipientWaId: String(s.recipient_id) });
      }
    }
  }
  return { messages, statuses };
}
