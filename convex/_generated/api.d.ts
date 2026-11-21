/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as api_ from "../api.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as mod_auth from "../mod/auth.js";
import type * as mod_catalog from "../mod/catalog.js";
import type * as mod_crm from "../mod/crm.js";
import type * as mod_misc from "../mod/misc.js";
import type * as mod_reports from "../mod/reports.js";
import type * as mod_sales from "../mod/sales.js";
import type * as mod_suppliers from "../mod/suppliers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  api: typeof api_;
  http: typeof http;
  lib: typeof lib;
  "mod/auth": typeof mod_auth;
  "mod/catalog": typeof mod_catalog;
  "mod/crm": typeof mod_crm;
  "mod/misc": typeof mod_misc;
  "mod/reports": typeof mod_reports;
  "mod/sales": typeof mod_sales;
  "mod/suppliers": typeof mod_suppliers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
