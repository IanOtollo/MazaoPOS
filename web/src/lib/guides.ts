import type { Permission } from "../../../shared/permissions";

/** Step-by-step walkthroughs for the jobs people do most. A guide only shows to people whose role can do it. */
export interface Guide {
  id: string;
  title: string;
  summary: string;
  group: "Selling" | "Stock" | "Customers" | "Suppliers" | "Business";
  needs?: Permission;
  go: string; // where "Take me there" goes
  steps: { text: string; tip?: string }[];
}

export const GUIDES: Guide[] = [
  {
    id: "sale", title: "Make a sale", summary: "Ring up items and take payment.", group: "Selling", needs: "sales.create", go: "/",
    steps: [
      { text: "Open Sell from the menu. If it asks you to start a shift, enter the cash in the drawer and press Start shift.", tip: "You cannot sell without an open shift. This is how the day's cash is tracked." },
      { text: "Find the item. Type its name or code, or scan the barcode, then tap it to add it to the sale." },
      { text: "Check the cart. Change the quantity if needed. Items sold by the metre or kilo accept decimals." },
      { text: "Need to give a discount? Press Add discount. If your role cannot, a manager types their PIN." },
      { text: "Press Pay and choose cash, M-Pesa or card. Use Split payment when the customer pays with more than one." },
      { text: "Print receipt if the customer wants one, then press New sale." },
    ],
  },
  {
    id: "shift", title: "Start and close your shift", summary: "Count the drawer at the start and the end of the day.", group: "Selling", needs: "sales.create", go: "/shift",
    steps: [
      { text: "Open Shift & cash-up. Enter the cash in the drawer and press Start shift." },
      { text: "Sell as normal during the day. Every sale is tied to your shift." },
      { text: "At the end, open Shift & cash-up again and press Close shift." },
      { text: "Count the cash in the drawer and type the amount. The system shows what it expected and any difference.", tip: "A difference is recorded, not hidden. A manager can see it later." },
      { text: "Press Print to keep a copy of the cash-up." },
    ],
  },
  {
    id: "credit", title: "Sell on credit", summary: "Let a registered customer take goods and pay later.", group: "Selling", needs: "sales.create", go: "/",
    steps: [
      { text: "The customer must be registered first (see Register a customer who borrows). Cashiers cannot see what anyone owes." },
      { text: "Add the items to the cart as usual." },
      { text: "Choose the customer's account instead of No account, ordinary sale." },
      { text: "Press Pay and choose Credit (pay later). If your role cannot give credit, a manager types their PIN.", tip: "Credit is refused if it goes over the customer's limit, or if their credit has been stopped." },
      { text: "Print the receipt. The amount is added to what the customer owes." },
    ],
  },
  {
    id: "refund", title: "Refund a sale", summary: "Take back items and return the money or credit.", group: "Selling", go: "/sales",
    steps: [
      { text: "Open Sales history and find the sale. Search by receipt number if you have it." },
      { text: "Open the sale and press Refund items." },
      { text: "Choose the items and quantities coming back." },
      { text: "Press Process refund. If your role cannot refund, a manager types their PIN.", tip: "Returned goods go back into stock automatically." },
      { text: "Press Reprint to print the refund slip." },
    ],
  },
  {
    id: "product", title: "Add a product", summary: "Create an item with its price and VAT.", group: "Stock", needs: "products.manage", go: "/inventory",
    steps: [
      { text: "Open Inventory and press Add product." },
      { text: "Type the name and a code. Add the barcode if the item has one." },
      { text: "Choose the unit (piece, kg, metre and so on) and the VAT class." },
      { text: "Enter the cost and the selling price. Contractor and wholesale prices are optional." },
      { text: "Sell it in other sizes too? Press Add a pack size, for example a roll, a dozen or a box." },
      { text: "Press Save. To add opening stock, use the Receive stock button on the item's row." },
    ],
  },
  {
    id: "import", title: "Import or export many products", summary: "Load a whole price list from a spreadsheet, or download it.", group: "Stock", needs: "products.manage", go: "/inventory",
    steps: [
      { text: "Open Inventory. To get a copy of everything, press Export. It downloads as a CSV file you can open in Excel." },
      { text: "To bring products in, press Import and then Download template to see the columns." },
      { text: "Fill in your products, one per row. Save the file as CSV (in Excel: File, Save As, CSV)." },
      { text: "Press Choose CSV file. The system checks every row and shows which ones need fixing.", tip: "Nothing is saved until you press the Import button at the bottom. Rows with problems are skipped." },
      { text: "Press Import. Big files are sent in batches, so wait until it finishes." },
    ],
  },
  {
    id: "stock", title: "Receive, count or move stock", summary: "Keep the quantities on the shelf correct.", group: "Stock", needs: "stock.manage", go: "/inventory",
    steps: [
      { text: "Open Inventory and find the item. Use the search box if the list is long." },
      { text: "Use the icons on the item's row: Receive stock for a delivery, Count stock to correct a quantity, Move between shop and store to transfer." },
      { text: "Enter the quantity. A count or a correction asks for a reason, so there is a record." },
      { text: "Save. The new quantity shows straight away on every screen." },
    ],
  },
  {
    id: "borrower", title: "Register a customer who borrows", summary: "Only people who take goods on credit need to be registered.", group: "Customers", needs: "customers.create", go: "/customers",
    steps: [
      { text: "Open Customers and press Register customer." },
      { text: "Type the name and phone number." },
      { text: "A manager sets the credit limit, the days they have to pay and their price tier." },
      { text: "Save. They can now be chosen at the till for a credit sale." },
    ],
  },
  {
    id: "collect", title: "Collect a customer's payment", summary: "Record money received against what a customer owes.", group: "Customers", needs: "customers.payment", go: "/customers",
    steps: [
      { text: "Open Customers and tap the customer." },
      { text: "Press Record payment, enter the amount and how they paid." },
      { text: "The oldest debt is settled first. You cannot take more than they owe." },
      { text: "Press Statement to print what they owe and how old each debt is.", tip: "You can also add a follow-up note with the date they promised to pay." },
    ],
  },
  {
    id: "order", title: "Order from a supplier (LPO)", summary: "Send a local purchase order, then receive the goods against it.", group: "Suppliers", needs: "suppliers.manage", go: "/suppliers",
    steps: [
      { text: "Open Suppliers. The To reorder tab lists items that are running low, grouped by supplier." },
      { text: "Press Make an order next to a supplier, or use the Orders tab and New order to build one by hand." },
      { text: "Check the quantities and buying prices. Press Save and mark as sent." },
      { text: "Press Print to give the supplier a clean copy of the LPO." },
      { text: "When the goods arrive, open the order and press Receive goods. Enter what came.", tip: "If only part arrives, the order stays open until the rest is received." },
    ],
  },
  {
    id: "paysupplier", title: "Pay a supplier", summary: "Record what you paid, or a credit note they gave you.", group: "Suppliers", needs: "suppliers.manage", go: "/suppliers",
    steps: [
      { text: "Open Suppliers and tap the supplier. The page shows what you owe and how old it is." },
      { text: "Press Pay supplier, enter the amount and how you paid." },
      { text: "Choose credit note instead if the supplier reduced the bill." },
    ],
  },
  {
    id: "staff", title: "Add staff and choose what they can do", summary: "Each person signs in with their own PIN.", group: "Business", needs: "users.manage", go: "/settings?tab=staff",
    steps: [
      { text: "Open Settings, then Staff, and press Add staff." },
      { text: "Type their name, pick a role and give them a PIN of 4 to 8 digits.", tip: "Every PIN must be different. The PIN is how the system knows who is selling." },
      { text: "To change what a role can do, open Roles & access and edit the role." },
      { text: "To stop someone signing in, disable their account. Their past sales stay on record." },
    ],
  },
  {
    id: "business", title: "Change the shop name and logo", summary: "What shows on the sign-in screen and receipts.", group: "Business", needs: "settings.manage", go: "/settings",
    steps: [
      { text: "Open Settings, then Business." },
      { text: "Change the name, address and phone. The receipt footer is the line printed at the bottom of each receipt." },
      { text: "Upload your logo. A PNG or JPG under 400 KB works best." },
      { text: "Press Save settings." },
    ],
  },
  {
    id: "reports", title: "Read the dashboard and reports", summary: "See how the day, week or month is going.", group: "Business", needs: "reports.view", go: "/dashboard",
    steps: [
      { text: "Open Dashboard. It opens on Today." },
      { text: "Use Today, 7 days, 30 days or the date picker to look at another period." },
      { text: "Each card compares with the period before it, so you can see if things are up or down." },
      { text: "Open Reports for the detail: sales, VAT, profit and top items." },
    ],
  },
];
