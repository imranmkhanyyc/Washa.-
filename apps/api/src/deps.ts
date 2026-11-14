import { EventEmitter } from "node:events";
import type { DB } from "@washa/db";
import type { Clock } from "./clock";
import type { Config } from "./config";
import type { JobQueue } from "./jobs/queue";
import type { WhatsAppClient } from "./whatsapp/types";
import type { AiService } from "./ai/service";
import type { DarajaClient } from "./mpesa/daraja";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface Deps {
  db: DB;
  config: Config;
  clock: Clock;
  queue: JobQueue;
  wa: WhatsAppClient;
  ai: AiService;
  mpesa: DarajaClient;
  /** In-process realtime bus (packing screen stub). Module 4 moves this to Supabase Realtime. */
  events: EventEmitter;
  log: Logger;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
