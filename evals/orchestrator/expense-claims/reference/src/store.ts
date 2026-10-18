import type { Expense } from "./expenses.ts";
import type { Report } from "./reports.ts";

export class Store {
  expenses = new Map<string, Expense>();
  reports = new Map<string, Report>();
  #seq = 0;

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq}`;
  }
}
