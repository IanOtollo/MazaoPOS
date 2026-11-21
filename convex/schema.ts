import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/*
 * MazaoPOS data model.
 *
 * Every business record keeps a small whole-number `id` (from the `counters` table) next to Convex's own
 * `_id`. The screens already use numeric ids everywhere (product 12, location 1, receipt lines...), so keeping
 * them means the screens do not have to change. Money is whole cents, quantities are whole thousandths,
 * times are milliseconds since 1970.
 *
 * Running balances (stock on hand, what a customer owes) are kept in step with the append-only records
 * inside the same transaction, so a screen never has to add up thousands of rows to show one number.
 */
const vat = v.union(v.literal("A"), v.literal("B"), v.literal("E"));
const tier = v.union(v.literal("retail"), v.literal("contractor"), v.literal("wholesale"));
const method = v.union(v.literal("cash"), v.literal("mpesa"), v.literal("card"), v.literal("bank"), v.literal("credit"));

export default defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  topics: defineTable({ name: v.string(), version: v.number() }).index("by_name", ["name"]),
  files: defineTable({ name: v.string(), mime: v.string(), base64: v.string(), updatedAt: v.number() }).index("by_name", ["name"]),
  settings: defineTable({ key: v.string(), value: v.string() }).index("by_key", ["key"]),

  // ---- people and access
  roles: defineTable({
    id: v.number(), name: v.string(), description: v.string(), isSystem: v.boolean(), permissions: v.array(v.string()),
  }).index("by_numId", ["id"]).index("by_name", ["name"]),
  users: defineTable({
    id: v.number(), name: v.string(), pinHash: v.string(), roleId: v.number(), active: v.boolean(), createdAt: v.number(),
  }).index("by_numId", ["id"]),
  sessions: defineTable({ token: v.string(), userId: v.number(), createdAt: v.number() }).index("by_token", ["token"]).index("by_user", ["userId"]),
  loginAttempts: defineTable({ key: v.string(), count: v.number(), until: v.number() }).index("by_key", ["key"]),
  auditLog: defineTable({ userId: v.optional(v.number()), action: v.string(), detail: v.optional(v.string()), createdAt: v.number() }).index("by_time", ["createdAt"]),

  // ---- catalogue and stock
  locations: defineTable({ id: v.number(), name: v.string() }).index("by_numId", ["id"]),
  categories: defineTable({ id: v.number(), name: v.string() }).index("by_numId", ["id"]).index("by_name", ["name"]),
  products: defineTable({
    id: v.number(), sku: v.string(), barcode: v.optional(v.string()), name: v.string(), categoryId: v.optional(v.number()),
    unit: v.string(), allowFraction: v.boolean(), vatCode: vat,
    costCents: v.number(), priceRetailCents: v.number(), priceContractorCents: v.optional(v.number()), priceWholesaleCents: v.optional(v.number()),
    reorderLevelMilli: v.number(), active: v.boolean(),
    itemClassCode: v.optional(v.string()), qtyUnitCode: v.optional(v.string()), packUnitCode: v.optional(v.string()), originCountry: v.optional(v.string()),
    // other ways to sell it: a roll, a dozen, a box. factorMilli = how many of the product's own unit one of these holds (x1000)
    units: v.array(v.object({ id: v.number(), name: v.string(), factorMilli: v.number(), priceCents: v.optional(v.number()), barcode: v.optional(v.string()) })),
    createdAt: v.number(),
  }).index("by_numId", ["id"]).index("by_sku", ["sku"]).index("by_barcode", ["barcode"]).index("by_category", ["categoryId"]),
  stock: defineTable({ productId: v.number(), locationId: v.number(), qtyMilli: v.number() }).index("by_product_location", ["productId", "locationId"]).index("by_product", ["productId"]),
  stockMovements: defineTable({
    id: v.number(), productId: v.number(), locationId: v.number(), qtyMilli: v.number(), type: v.string(),
    refType: v.optional(v.string()), refId: v.optional(v.number()), unitCostCents: v.optional(v.number()),
    note: v.optional(v.string()), userId: v.optional(v.number()), createdAt: v.number(),
  }).index("by_product", ["productId", "createdAt"]),

  // ---- selling
  shifts: defineTable({
    id: v.number(), userId: v.number(), openedAt: v.number(), closedAt: v.optional(v.number()), openingFloatCents: v.number(),
    countedCashCents: v.optional(v.number()), expectedCashCents: v.optional(v.number()), note: v.optional(v.string()),
  }).index("by_numId", ["id"]).index("by_user", ["userId", "closedAt"]),
  sales: defineTable({
    id: v.number(), receiptNo: v.string(), shiftId: v.optional(v.number()), userId: v.number(), customerId: v.optional(v.number()), locationId: v.number(),
    kind: v.union(v.literal("sale"), v.literal("refund")), refundOf: v.optional(v.number()),
    subtotalCents: v.number(), discountCents: v.number(), totalCents: v.number(), vatCents: v.number(),
    note: v.optional(v.string()), approvedBy: v.optional(v.number()), etimsStatus: v.string(), createdAt: v.number(),
    items: v.array(v.object({
      id: v.number(), productId: v.number(), name: v.string(), unit: v.string(), qtyMilli: v.number(), unitPriceCents: v.number(),
      costCents: v.number(), vatCode: vat, lineTotalCents: v.number(), vatCents: v.number(), baseQtyMilli: v.number(),
    })),
    payments: v.array(v.object({ method, amountCents: v.number(), reference: v.optional(v.string()) })),
  }).index("by_numId", ["id"]).index("by_receipt", ["receiptNo"]).index("by_created", ["createdAt"]).index("by_shift", ["shiftId"]).index("by_refund_of", ["refundOf"]),

  // ---- customers who borrow
  customers: defineTable({
    id: v.number(), name: v.string(), phone: v.optional(v.string()), tier, creditLimitCents: v.number(), creditDays: v.number(),
    creditStopped: v.boolean(), active: v.boolean(), balanceCents: v.number(), createdAt: v.number(),
  }).index("by_numId", ["id"]),
  customerLedger: defineTable({
    id: v.number(), customerId: v.number(), amountCents: v.number(), type: v.string(), refType: v.optional(v.string()), refId: v.optional(v.number()),
    method: v.optional(v.string()), note: v.optional(v.string()), userId: v.optional(v.number()), createdAt: v.number(),
  }).index("by_customer", ["customerId", "createdAt"]),
  customerNotes: defineTable({
    id: v.number(), customerId: v.number(), userId: v.optional(v.number()), kind: v.string(), body: v.string(),
    promiseDate: v.optional(v.string()), promiseCents: v.optional(v.number()), createdAt: v.number(),
  }).index("by_customer", ["customerId", "createdAt"]),

  // ---- buying
  suppliers: defineTable({
    id: v.number(), name: v.string(), phone: v.optional(v.string()), email: v.optional(v.string()), creditDays: v.number(), active: v.boolean(), balanceCents: v.number(), createdAt: v.number(),
  }).index("by_numId", ["id"]),
  purchases: defineTable({
    id: v.number(), supplierId: v.number(), invoiceNo: v.optional(v.string()), locationId: v.number(), totalCents: v.number(), note: v.optional(v.string()),
    userId: v.optional(v.number()), receivedOn: v.string(), createdAt: v.number(),
    items: v.array(v.object({ productId: v.number(), name: v.string(), qtyMilli: v.number(), unitCostCents: v.number() })),
  }).index("by_numId", ["id"]).index("by_supplier", ["supplierId", "createdAt"]),
  supplierLedger: defineTable({
    id: v.number(), supplierId: v.number(), amountCents: v.number(), type: v.string(), refId: v.optional(v.number()),
    method: v.optional(v.string()), note: v.optional(v.string()), userId: v.optional(v.number()), createdAt: v.number(),
  }).index("by_supplier", ["supplierId", "createdAt"]),
});
