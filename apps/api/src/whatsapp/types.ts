/** Our outbound message model. Mapped to Cloud API payloads in client.ts. */
export interface Button {
  id: string;
  /** ≤ 20 chars (Cloud API limit). */
  title: string;
}
export interface ListRow {
  id: string;
  /** ≤ 24 chars. */
  title: string;
  /** ≤ 72 chars. */
  description?: string;
}

export type OutMessage =
  | { kind: "text"; body: string }
  | { kind: "buttons"; body: string; buttons: Button[] }
  | { kind: "list"; body: string; button: string; rows: ListRow[] }
  | { kind: "location_request"; body: string }
  | { kind: "template"; name: string; lang?: string; params: string[] };

/** Normalised inbound message. */
export type InMessage = {
  waMessageId: string;
  waId: string;
  profileName?: string;
  timestamp: Date;
} & (
  | { kind: "text"; text: string }
  | { kind: "button"; id: string; title: string }
  | { kind: "location"; lat: number; lng: number; name?: string; address?: string }
  | { kind: "image"; mediaId: string; mimeType?: string; caption?: string }
  | { kind: "unsupported"; type: string }
);

export interface WhatsAppClient {
  send(toWaId: string, msg: OutMessage): Promise<{ waMessageId: string }>;
  getMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export const LIMITS = { buttons: 3, buttonTitle: 20, rows: 10, rowTitle: 24, rowDescription: 72, body: 1024 };

export function validateOut(msg: OutMessage): void {
  if (msg.kind === "buttons") {
    if (msg.buttons.length < 1 || msg.buttons.length > LIMITS.buttons) throw new Error(`buttons: 1-${LIMITS.buttons} allowed`);
    for (const b of msg.buttons) if (b.title.length > LIMITS.buttonTitle) throw new Error(`button title too long: ${b.title}`);
  }
  if (msg.kind === "list") {
    if (msg.rows.length < 1 || msg.rows.length > LIMITS.rows) throw new Error(`list: 1-${LIMITS.rows} rows allowed`);
    for (const r of msg.rows) {
      if (r.title.length > LIMITS.rowTitle) throw new Error(`row title too long: ${r.title}`);
      if (r.description && r.description.length > LIMITS.rowDescription) throw new Error(`row description too long: ${r.description}`);
    }
  }
  if ("body" in msg && msg.body.length > LIMITS.body) throw new Error("body too long");
}
