"use client";
/**
 * Packing screen STUB (Module 3 acceptance: "paid order appears in real time, stub OK").
 * Module 4 replaces this with the tablet UI on Supabase Realtime.
 */
import { useEffect, useState } from "react";

type Item = { sku: string; qty: number; bin: string | null };
type Order = { id: string; number: string; status: string; totalKes: number; customerName: string | null; priority: boolean; createdAt: string; items: Item[] };

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function PackPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const load = () => fetch(`${API}/pack/queue`).then((r) => r.json()).then((d) => setOrders(d.orders)).catch(() => {});
    load();
    const es = new EventSource(`${API}/pack/stream`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.addEventListener("order.paid", load);
    return () => es.close();
  }, []);

  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ margin: 0 }}>Packing queue <span style={{ fontSize: 14, color: live ? "#c6ff00" : "#888" }}>● {live ? "live" : "offline"}</span></h1>
      {orders.length === 0 && <p style={{ color: "#888" }}>No paid orders waiting.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {orders.map((o) => (
          <li key={o.id} style={{ border: `2px solid ${o.priority ? "#c6ff00" : "#333"}`, borderRadius: 12, padding: 16, margin: "12px 0" }}>
            <strong style={{ fontSize: 22 }}>{o.number}</strong> {o.priority && <span style={{ color: "#c6ff00" }}>PRIORITY</span>}
            <div style={{ color: "#aaa" }}>{o.customerName ?? "Customer"} · {o.status} · paid order since {new Date(o.createdAt).toLocaleTimeString()}</div>
            <ul>{o.items.map((i) => <li key={i.sku}>{i.qty} × {i.sku} {i.bin ? `(bin ${i.bin})` : ""}</li>)}</ul>
          </li>
        ))}
      </ul>
    </main>
  );
}
