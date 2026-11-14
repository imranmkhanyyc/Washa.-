/**
 * Seed data. EVERYTHING HERE IS A PLACEHOLDER until ops confirm it:
 * - brands + prices: docs/05 #5 ("prices [__]")
 * - fitments: Kenyan market best-knowledge, verify against OEM / supplier catalogues
 * - zones + settings: docs/06 starter table
 * - D2C tiers: docs/05 #3
 */
export const SIZE_FAMILIES = ["NS40", "NS60", "NS70", "N70"] as const;

// Placeholder brand list (the deck shortlist was not in the repo; replace with the final 5).
export const BRANDS = [
  { brand: "Chloride Exide", code: "CHX", mult: 1.0, warranty: 12 },
  { brand: "Amaron", code: "AMR", mult: 1.12, warranty: 18 },
  { brand: "Bosch", code: "BSH", mult: 1.25, warranty: 18 },
  { brand: "Varta", code: "VRT", mult: 1.3, warranty: 24 },
  { brand: "Yuasa", code: "YSA", mult: 1.2, warranty: 18 },
] as const;

const SIZE_SPECS = [
  { size: "NS40", pol: "L", model: "38B19L", ah: 35, cca: 300, base: 7_500 },
  { size: "NS60", pol: "L", model: "46B24L", ah: 45, cca: 360, base: 9_500 },
  { size: "NS70", pol: "L", model: "75D23L", ah: 65, cca: 520, base: 12_000 },
  { size: "NS70", pol: "R", model: "75D23R", ah: 65, cca: 520, base: 12_000 },
  { size: "N70", pol: "L", model: "105D31L", ah: 80, cca: 640, base: 15_500 },
] as const;

const round50 = (n: number) => Math.round(n / 50) * 50;

export const PRODUCTS = BRANDS.flatMap((b) =>
  SIZE_SPECS.map((s) => ({
    sku: `${b.code}-${s.size}${s.pol}`,
    brand: b.brand,
    sizeFamily: s.size,
    modelCode: s.model,
    ah: s.ah,
    cca: s.cca,
    polarity: s.pol as "L" | "R",
    terminal: "standard",
    warrantyMonths: b.warranty,
    priceKes: round50(s.base * b.mult),
    pricePlaceholder: true,
    active: true,
  })),
);

export const STOCK = PRODUCTS.map((p, i) => ({
  sku: p.sku,
  qtyOnHand: 10,
  qtyReserved: 0,
  reorderLevel: 3,
  binLocation: `R${Math.floor(i / 5) + 1}-${(i % 5) + 1}`,
}));

const NOTE = "PLACEHOLDER seed: verify size and polarity against OEM/supplier catalogue";
type F = [make: string, model: string, from: number, to: number, engine: string | null, size: string, pol: "L" | "R"];
/** 30 of the most common cars on Kenyan roads (placeholder fitments). */
const F_ROWS: F[] = [
  ["Toyota", "Vitz", 2005, 2019, null, "NS40", "L"],
  ["Toyota", "Passo", 2004, 2016, null, "NS40", "L"],
  ["Toyota", "Axio", 2006, 2019, null, "NS40", "L"],
  ["Toyota", "Fielder", 2006, 2019, null, "NS60", "L"],
  ["Toyota", "Premio", 2001, 2020, null, "NS60", "L"],
  ["Toyota", "Probox", 2002, 2023, null, "NS40", "L"],
  ["Toyota", "Wish", 2003, 2017, null, "NS60", "L"],
  ["Toyota", "Noah", 2001, 2021, null, "NS60", "L"],
  ["Toyota", "Voxy", 2001, 2021, null, "NS60", "L"],
  ["Toyota", "Sienta", 2003, 2022, null, "NS40", "L"],
  ["Toyota", "Harrier", 2003, 2020, null, "NS70", "L"],
  ["Toyota", "RAV4", 2005, 2018, null, "NS70", "L"],
  ["Toyota", "Mark X", 2004, 2019, null, "NS70", "L"],
  ["Toyota", "Land Cruiser Prado", 2009, 2023, "Petrol", "NS70", "L"],
  ["Toyota", "Land Cruiser Prado", 2009, 2023, "Diesel", "N70", "L"],
  ["Toyota", "Hilux", 2005, 2023, "Petrol", "NS70", "L"],
  ["Toyota", "Hilux", 2005, 2023, "Diesel", "N70", "L"],
  ["Toyota", "Land Cruiser", 2008, 2021, null, "N70", "L"],
  ["Nissan", "Note", 2005, 2020, null, "NS40", "L"],
  ["Nissan", "X-Trail", 2007, 2021, "Petrol", "NS60", "L"],
  ["Nissan", "X-Trail", 2007, 2021, "Diesel", "NS70", "L"],
  ["Nissan", "Navara", 2005, 2021, null, "N70", "L"],
  ["Subaru", "Forester", 2008, 2021, null, "NS60", "L"],
  ["Subaru", "Outback", 2009, 2021, null, "NS60", "L"],
  ["Subaru", "Impreza", 2007, 2021, null, "NS40", "L"],
  ["Mazda", "Demio", 2007, 2019, null, "NS40", "L"],
  ["Mazda", "CX-5", 2012, 2022, null, "NS70", "L"],
  ["Honda", "Fit", 2007, 2020, null, "NS40", "L"],
  ["Honda", "Vezel", 2013, 2021, null, "NS40", "L"],
  ["Honda", "CR-V", 2007, 2018, null, "NS60", "L"],
  ["Mitsubishi", "Outlander", 2007, 2021, null, "NS60", "L"],
  ["Isuzu", "D-Max", 2012, 2023, null, "N70", "L"],
  ["Suzuki", "Swift", 2005, 2017, null, "NS40", "L"],
];
export const FITMENTS = F_ROWS.map(([make, model, yearFrom, yearTo, engine, sizeFamily, polarity]) => ({
  make, model, yearFrom, yearTo, engine, sizeFamily, polarity, notes: NOTE,
}));

/** Make list shown in WhatsApp (top 9 + Other). PLACEHOLDER ordering. */
export const TOP_MAKES = ["Toyota", "Nissan", "Subaru", "Mazda", "Honda", "Mitsubishi", "Isuzu", "Suzuki", "Volkswagen"];

export const SIZE_COMPAT = [
  { fromSize: "NS40", toSize: "NS60", rank: 1, notes: "PLACEHOLDER: check tray fit before offering" },
  { fromSize: "NS60", toSize: "NS70", rank: 1, notes: "PLACEHOLDER: check tray fit before offering" },
];

export const TIER_CONFIG = [
  { track: "b2b", tier: "silver", label: "Silver", rank: 1, minSpendKes: 0, itemDiscountPct: "0", deliveryDiscountPct: "0", priorityQueue: false, perks: {}, placeholder: false },
  { track: "b2b", tier: "gold", label: "Gold", rank: 2, minSpendKes: 1_000_000, itemDiscountPct: "3", deliveryDiscountPct: "50", priorityQueue: false, perks: {}, placeholder: false },
  { track: "b2b", tier: "platinum", label: "Platinum", rank: 3, minSpendKes: 2_500_000, itemDiscountPct: "5", deliveryDiscountPct: "100", priorityQueue: true, perks: {}, placeholder: false },
  { track: "d2c", tier: "member", label: "Member", rank: 1, minSpendKes: 0, itemDiscountPct: "0", deliveryDiscountPct: "0", priorityQueue: false, perks: { battery_health_reminders: true }, placeholder: true },
  { track: "d2c", tier: "plus", label: "Plus", rank: 2, minSpendKes: 25_000, itemDiscountPct: "2", deliveryDiscountPct: "25", priorityQueue: false, perks: { battery_health_reminders: true, free_health_check: true }, placeholder: true },
  { track: "d2c", tier: "pro", label: "Pro", rank: 3, minSpendKes: 60_000, itemDiscountPct: "3", deliveryDiscountPct: "50", priorityQueue: true, perks: { battery_health_reminders: true, free_health_check: true }, placeholder: true },
] as const;

export const DELIVERY_SETTINGS = {
  id: 1,
  warehouseLat: -1.2841,
  warehouseLng: 36.8219,
  peakWindows: [
    { days: [1, 2, 3, 4, 5], start: "07:00", end: "09:30" },
    { days: [1, 2, 3, 4, 5], start: "16:30", end: "19:00" },
  ],
  bulkThresholdUnits: 6,
  maxUnitsPerTrip: 2,
  roundingKes: 10,
  bulkRunTime: "10:00",
  placeholder: true,
};

const ring = (code: string, name: string, minKm: string, maxKm: string, base: number, extra: number, eta: number | null, freeOver: number | null) => ({
  code, name, kind: "ring" as const, minKm, maxKm, polygon: null, priority: 100,
  baseFeeKes: base, perExtraUnitKes: extra, includedUnits: 1, peakSurchargeKes: 100,
  freeDeliveryOverKes: freeOver, etaMinutes: eta, etaCutoffTime: eta == null ? "18:00" : null,
  placeholder: true, active: true,
});

export const DELIVERY_ZONES = [
  ring("A", "Core", "0", "5", 200, 100, 45, 15_000),
  ring("B", "Inner", "5", "10", 350, 150, 75, 25_000),
  ring("C", "Outer", "10", "20", 550, 200, 120, null),
  ring("D", "Metro edge", "20", "35", 800, 250, null, null),
];

export const STAFF = [{ name: "GM (placeholder)", role: "gm" as const, phone: "+254700000001" }];
